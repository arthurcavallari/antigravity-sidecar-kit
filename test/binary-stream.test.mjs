import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import {
  encodeConnectFrame,
  parseConnectFrames,
  encodeWsFrame,
  decodeWsFrames,
  attachWebSocketRoute,
} from '../lib/binary-stream.mjs';
import {
  encodeConnectFrame as rpcEncodeConnectFrame,
  parseConnectFrames as rpcParseConnectFrames,
} from '../lib/rpc.mjs';

function buildMaskedClientFrame(payload, opcode = 0x01, maskKey = [0x37, 0xfa, 0x21, 0x3d]) {
  const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = raw.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | len;
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const maskBuf = Buffer.from(maskKey);
  const maskedPayload = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    maskedPayload[i] = raw[i] ^ maskBuf[i & 3];
  }
  return Buffer.concat([header, maskBuf, maskedPayload]);
}

describe('antigravity-sidecar-kit/binary-stream', () => {
  it('re-exports encodeConnectFrame and parseConnectFrames from lib/rpc.mjs', () => {
    assert.equal(rpcEncodeConnectFrame, encodeConnectFrame);
    assert.equal(rpcParseConnectFrames, parseConnectFrames);
  });

  it('encodeConnectFrame and parseConnectFrames round-trip split multi-frame buffers and fallback types', () => {
    const f1 = encodeConnectFrame({ step: 1 }, 0);
    const f2 = encodeConnectFrame({ end: true }, 2);
    const f3 = encodeConnectFrame('plain-text-payload', 0);
    const f4 = encodeConnectFrame(Buffer.from([0xff, 0xfe, 0x00, 0x80]), 1);
    const combined = Buffer.concat([f1, f2, f3, f4]);

    // Split inside first 5-byte header (only 3 bytes available)
    const headChunk = parseConnectFrames(combined.subarray(0, 3));
    assert.equal(headChunk.frames.length, 0);
    assert.equal(headChunk.rest.length, 3);

    // Feed up to 3 bytes into f2
    const partial = parseConnectFrames(combined.subarray(0, f1.length + 3));
    assert.equal(partial.frames.length, 1);
    assert.equal(partial.frames[0].flags, 0);
    assert.deepEqual(partial.frames[0].data, { step: 1 });
    assert.ok(Buffer.isBuffer(partial.frames[0].raw));

    // Feed remainder containing rest of f2, f3, and f4
    const remainder = parseConnectFrames(
      Buffer.concat([partial.rest, combined.subarray(f1.length + 3)])
    );
    assert.equal(remainder.frames.length, 3);
    assert.equal(remainder.rest.length, 0);

    assert.equal(remainder.frames[0].flags, 2);
    assert.deepEqual(remainder.frames[0].data, { end: true });

    assert.equal(remainder.frames[1].flags, 0);
    assert.equal(remainder.frames[1].data, 'plain-text-payload');

    assert.equal(remainder.frames[2].flags, 1);
    assert.ok(Buffer.isBuffer(remainder.frames[2].data));
    assert.deepEqual(remainder.frames[2].data, Buffer.from([0xff, 0xfe, 0x00, 0x80]));
  });

  it('encodeWsFrame and decodeWsFrames support 7-bit, 16-bit, and 64-bit lengths plus client XOR unmasking', () => {
    const shortText = 'hello ws';
    const medBuf = Buffer.alloc(1024, 0x42);
    const largeBuf = Buffer.alloc(70_000, 0x7a);

    // Server unmasked frames
    const s1 = encodeWsFrame(shortText, 0x01);
    const s2 = encodeWsFrame(medBuf, 0x02);
    const s3 = encodeWsFrame(largeBuf, 0x02);

    const decodedServer = decodeWsFrames(Buffer.concat([s1, s2, s3]));
    assert.equal(decodedServer.rest.length, 0);
    assert.equal(decodedServer.frames.length, 3);
    assert.equal(decodedServer.frames[0].fin, true);
    assert.equal(decodedServer.frames[0].opcode, 0x01);
    assert.equal(decodedServer.frames[0].payload.toString('utf8'), shortText);
    assert.equal(decodedServer.frames[1].opcode, 0x02);
    assert.deepEqual(decodedServer.frames[1].payload, medBuf);
    assert.equal(decodedServer.frames[2].opcode, 0x02);
    assert.deepEqual(decodedServer.frames[2].payload, largeBuf);

    // Client masked frames across chunk splits
    const c1 = buildMaskedClientFrame(shortText, 0x01);
    const c2 = buildMaskedClientFrame(medBuf, 0x02);
    const c3 = buildMaskedClientFrame(largeBuf, 0x02);
    const allClient = Buffer.concat([c1, c2, c3]);

    // Split mid-extended header of c2
    const splitPoint = c1.length + 3;
    const part1 = decodeWsFrames(allClient.subarray(0, splitPoint));
    assert.equal(part1.frames.length, 1);
    assert.equal(part1.frames[0].payload.toString('utf8'), shortText);
    assert.equal(part1.rest.length, 3);

    const part2 = decodeWsFrames(Buffer.concat([part1.rest, allClient.subarray(splitPoint)]));
    assert.equal(part2.frames.length, 2);
    assert.equal(part2.rest.length, 0);
    assert.deepEqual(part2.frames[0].payload, medBuf);
    assert.deepEqual(part2.frames[1].payload, largeBuf);
  });

  it('attachWebSocketRoute enforces ANTIGRAVITY_SIDECAR_UI_TOKEN, performs RFC 6455 handshake, and handles messages + ping/pong', async () => {
    const prevToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
    process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = 'secret-ws-token-123';

    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    const receivedMessages = [];
    let closedCount = 0;

    attachWebSocketRoute(server, '/ws', {
      verifyToken: true,
      onConnection(wsClient) {
        wsClient.onMessage((data, frame) => {
          receivedMessages.push({ data, opcode: frame.opcode });
          if (frame.opcode === 0x01 && data === 'ping-json') {
            wsClient.sendJson({ ack: true });
          } else if (frame.opcode === 0x02) {
            wsClient.sendBinary(Buffer.from([0xde, 0xad]));
          } else if (frame.opcode === 0x01) {
            wsClient.sendText(`echo:${data}`);
          }
        });
        wsClient.onClose(() => {
          closedCount++;
        });
      },
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      // 1. Unauthenticated upgrade request must receive 401 Unauthorized
      const unauthStatus = await new Promise((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1', () => {
          sock.write(
            'GET /ws?token=wrong-token HTTP/1.1\r\n' +
              'Host: 127.0.0.1\r\n' +
              'Upgrade: websocket\r\n' +
              'Connection: Upgrade\r\n' +
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'
          );
        });
        let resp = '';
        sock.on('data', (chunk) => {
          resp += chunk.toString('utf8');
        });
        sock.on('close', () => resolve(resp));
        sock.on('error', reject);
      });
      assert.ok(unauthStatus.startsWith('HTTP/1.1 401 Unauthorized'));

      // 2. Authenticated upgrade request succeeds and exchanges frames
      await new Promise((resolve, reject) => {
        const wsKey = 'dGhlIHNhbXBsZSBub25jZQ==';
        const expectedAccept = createHash('sha1')
          .update(wsKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
          .digest('base64');

        const sock = net.connect(port, '127.0.0.1', () => {
          sock.write(
            'GET /ws?token=secret-ws-token-123 HTTP/1.1\r\n' +
              'Host: 127.0.0.1\r\n' +
              'Upgrade: websocket\r\n' +
              'Connection: Upgrade\r\n' +
              `Sec-WebSocket-Key: ${wsKey}\r\n\r\n`
          );
        });

        let handshakeDone = false;
        let closeSent = false;
        let buf = Buffer.alloc(0);
        const serverFrames = [];

        sock.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          if (!handshakeDone) {
            const headerEnd = buf.indexOf('\r\n\r\n');
            if (headerEnd === -1) return;
            const headerStr = buf.subarray(0, headerEnd).toString('utf8');
            assert.ok(headerStr.startsWith('HTTP/1.1 101 Switching Protocols'));
            assert.ok(headerStr.includes(`Sec-WebSocket-Accept: ${expectedAccept}`));
            handshakeDone = true;
            buf = buf.subarray(headerEnd + 4);

            // Send text frame, binary frame, JSON trigger frame, and ping frame
            sock.write(
              Buffer.concat([
                buildMaskedClientFrame('hello-server', 0x01),
                buildMaskedClientFrame(Buffer.from([0x01, 0x02, 0x03]), 0x02),
                buildMaskedClientFrame('ping-json', 0x01),
                buildMaskedClientFrame('hb', 0x09),
              ])
            );
          }

          if (handshakeDone && buf.length > 0) {
            const parsed = decodeWsFrames(buf);
            buf = parsed.rest;
            serverFrames.push(...parsed.frames.filter((f) => f.opcode !== 0x08));
            if (!closeSent && serverFrames.length >= 4) {
              closeSent = true;
              sock.write(buildMaskedClientFrame(Buffer.alloc(0), 0x08));
              sock.end();
            }
          }
        });

        sock.on('close', () => {
          try {
            assert.equal(serverFrames.length, 4);
            assert.equal(serverFrames[0].opcode, 0x01);
            assert.equal(serverFrames[0].payload.toString('utf8'), 'echo:hello-server');
            assert.equal(serverFrames[1].opcode, 0x02);
            assert.deepEqual(serverFrames[1].payload, Buffer.from([0xde, 0xad]));
            assert.equal(serverFrames[2].opcode, 0x01);
            assert.deepEqual(JSON.parse(serverFrames[2].payload.toString('utf8')), { ack: true });
            // Automatic pong (0x0A) in reply to ping (0x09)
            assert.equal(serverFrames[3].opcode, 0x0a);
            assert.equal(serverFrames[3].payload.toString('utf8'), 'hb');
            resolve();
          } catch (err) {
            reject(err);
          }
        });
        sock.on('error', reject);
      });

      assert.equal(receivedMessages.length, 3);
      assert.equal(closedCount, 1);
    } finally {
      if (prevToken === undefined) delete process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
      else process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = prevToken;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('exports validator, hooks, skill-router, and binary-stream via package.json#exports and barrel index.mjs', async () => {
    const barrel = await import('../lib/index.mjs');
    assert.equal(typeof barrel.validateSidecarJson, 'function');
    assert.equal(typeof barrel.normalizeHookEnvelope, 'function');
    assert.equal(typeof barrel.routeSkillsForTurn, 'function');
    assert.equal(typeof barrel.attachWebSocketRoute, 'function');
    assert.equal(barrel.encodeConnectFrame, encodeConnectFrame);
    assert.equal(barrel.parseConnectFrames, parseConnectFrames);

    const validatorSub = await import('antigravity-sidecar-kit/validator');
    const manifestValidatorSub = await import('antigravity-sidecar-kit/manifest-validator');
    const hooksSub = await import('antigravity-sidecar-kit/hooks');
    const routerSub = await import('antigravity-sidecar-kit/skill-router');
    const streamSub = await import('antigravity-sidecar-kit/binary-stream');
    assert.equal(validatorSub.validateSidecarJson, barrel.validateSidecarJson);
    assert.equal(manifestValidatorSub.validateSidecarJson, barrel.validateSidecarJson);
    assert.equal(hooksSub.normalizeHookEnvelope, barrel.normalizeHookEnvelope);
    assert.equal(routerSub.routeSkillsForTurn, barrel.routeSkillsForTurn);
    assert.equal(streamSub.attachWebSocketRoute, barrel.attachWebSocketRoute);
    assert.equal(typeof streamSub.decodeConnectFrame, 'function');
    assert.equal(typeof streamSub.createConnectFrameAccumulator, 'function');
  });

  it('enforces maxFrameBytes, exposes decodeConnectFrame + createConnectFrameAccumulator, and blocks cross-origin WebSocket upgrades (F-01, XREPO-02)', async () => {
    const streamSub = await import('../lib/binary-stream.mjs');
    const single = streamSub.decodeConnectFrame(encodeConnectFrame({ hello: 'world' }, 0));
    assert.deepEqual(single.data, { hello: 'world' });
    assert.equal(single.flags, 0);

    const acc = streamSub.createConnectFrameAccumulator({ maxFrameBytes: 1024 });
    const f1 = encodeConnectFrame({ a: 1 }, 0);
    const f2 = encodeConnectFrame({ b: 2 }, 0);
    const combined = Buffer.concat([f1, f2]);
    assert.deepEqual(acc.push(combined.subarray(0, 3)), []);
    assert.equal(acc.remaining.length, 3);
    const out = acc.push(combined.subarray(3));
    assert.equal(out.length, 2);
    assert.deepEqual(out[0].data, { a: 1 });
    assert.deepEqual(out[1].data, { b: 2 });
    assert.equal(acc.remaining.length, 0);

    // Oversized Connect frame must throw RangeError
    const hugeConnectHeader = Buffer.alloc(5);
    hugeConnectHeader.writeUInt8(0, 0);
    hugeConnectHeader.writeUInt32BE(2048, 1);
    assert.throws(() => parseConnectFrames(hugeConnectHeader, { maxFrameBytes: 1024 }), RangeError);

    // Oversized 64-bit WebSocket frame must throw RangeError
    const hugeWsHeader = Buffer.alloc(10);
    hugeWsHeader[0] = 0x82;
    hugeWsHeader[1] = 127;
    hugeWsHeader.writeBigUInt64BE(BigInt(4096), 2);
    assert.throws(() => decodeWsFrames(hugeWsHeader, { maxFrameBytes: 1024 }), RangeError);

    // Cross-origin WebSocket upgrade must be rejected with 403 Forbidden even without UI token
    const prevToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
    delete process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
    const server = http.createServer((_req, res) => res.writeHead(404).end());
    attachWebSocketRoute(server, '/ws', { verifyToken: false });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const resp = await new Promise((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1', () => {
          sock.write(
            'GET /ws HTTP/1.1\r\n' +
              'Host: 127.0.0.1\r\n' +
              'Origin: https://evil.example.com\r\n' +
              'Upgrade: websocket\r\n' +
              'Connection: Upgrade\r\n' +
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'
          );
        });
        let data = '';
        sock.on('data', (c) => { data += c.toString('utf8'); });
        sock.on('close', () => resolve(data));
        sock.on('error', reject);
      });
      assert.ok(resp.startsWith('HTTP/1.1 403 Forbidden'));
    } finally {
      if (prevToken !== undefined) process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = prevToken;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('ASK-04 & ASK-11: attachWebSocketRoute handles pipelined multi-frame chunks > maxFrameBytes + 14, reassembles 0x00 continuation fragments, and parseConnectFrames detaches raw Buffer', async () => {
    // ASK-11: parseConnectFrames detaches raw buffer from input slab and skips JSON parse on compressed flag (0x01)
    const srcSlab = encodeConnectFrame(Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d]), 1);
    const parsedConnect = parseConnectFrames(srcSlab);
    assert.equal(parsedConnect.frames.length, 1);
    assert.equal(Buffer.isBuffer(parsedConnect.frames[0].data), true, 'compressed flag (0x01) must keep raw Buffer data');
    srcSlab[5] = 0x00;
    assert.equal(parsedConnect.frames[0].raw[0], 0x7b, 'frame.raw must not alias mutable input buffer');

    // ASK-04: pipelined frames + fragmented UTF-8 text message (0x01 fin:false + 0x00 fin:true)
    const server = http.createServer((_req, res) => res.writeHead(404).end());
    const received = [];
    let closed = false;
    attachWebSocketRoute(server, '/ws', {
      verifyToken: false,
      maxFrameBytes: 100,
      onConnection(wsClient) {
        wsClient.onMessage((data) => received.push(data));
        wsClient.onClose(() => { closed = true; });
      },
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      await new Promise((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1', () => {
          sock.write(
            'GET /ws HTTP/1.1\r\n' +
              'Host: 127.0.0.1\r\n' +
              'Upgrade: websocket\r\n' +
              'Connection: Upgrade\r\n' +
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'
          );
        });
        let upgraded = false;
        sock.on('data', (chunk) => {
          if (!upgraded && chunk.toString('utf8').includes('101 Switching Protocols')) {
            upgraded = true;
            // Two 60-byte frames in a single TCP chunk (total 132B > maxFrameBytes 100 + 14)
            const f1 = buildMaskedClientFrame('A'.repeat(60), 0x01);
            const f2 = buildMaskedClientFrame('B'.repeat(60), 0x01);
            // Fragmented UTF-8 message ("🚀" = F0 9F 9A 80 split across 0x01 fin=0 and 0x00 fin=1)
            const rocketBytes = Buffer.from('🚀', 'utf8');
            const frag1 = buildMaskedClientFrame(rocketBytes.subarray(0, 2), 0x01);
            frag1[0] &= 0x7f; // clear FIN bit
            const frag2 = buildMaskedClientFrame(rocketBytes.subarray(2), 0x00); // FIN=1, opcode=0x00
            sock.write(Buffer.concat([f1, f2, frag1, frag2, buildMaskedClientFrame(Buffer.alloc(0), 0x08)]));
            sock.end();
          }
        });
        sock.on('close', resolve);
        sock.on('error', reject);
      });
      assert.equal(closed, true);
      assert.deepEqual(received, ['A'.repeat(60), 'B'.repeat(60), '🚀']);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('supports rawOnly lazy decoding, split 5-byte headers, and >16 MiB frames with maxFrameBytes: Infinity', async () => {
    const streamSub = await import('../lib/binary-stream.mjs');
    let jsonParseCalls = 0;
    const origParse = JSON.parse;
    JSON.parse = (...args) => {
      jsonParseCalls += 1;
      return origParse(...args);
    };
    try {
      const dataFrame = encodeConnectFrame({ step: 42, text: 'hello' }, 0);
      const trailerFrame = encodeConnectFrame({ error: { code: 'not_found' } }, 2);
      const acc = streamSub.createConnectFrameAccumulator({ maxFrameBytes: Infinity, rawOnly: true });

      // Feed 1 byte at a time across the 5-byte header to exercise split-header peekConnectLength
      for (let i = 0; i < 5; i++) {
        assert.deepEqual(acc.push(dataFrame.subarray(i, i + 1)), []);
      }
      const frames = acc.push(Buffer.concat([dataFrame.subarray(5), trailerFrame]));
      assert.equal(frames.length, 2);
      // Only the trailer frame (flags=2) should have been JSON.parsed so far; flags=0 is lazy
      assert.equal(jsonParseCalls, 1);
      assert.equal(frames[1].data.error.code, 'not_found');
      assert.equal(frames[0].raw.toString('utf8'), '{"step":42,"text":"hello"}');
      // Accessing .data lazily parses once and memoizes
      assert.deepEqual(frames[0].data, { step: 42, text: 'hello' });
      assert.deepEqual(frames[0].data, { step: 42, text: 'hello' });
      assert.equal(jsonParseCalls, 2);
    } finally {
      JSON.parse = origParse;
    }

    // 18 MiB frame (> 16 MiB DEFAULT_MAX_FRAME_BYTES) succeeds when maxFrameBytes: Infinity
    const bigPayload = Buffer.alloc(18 * 1024 * 1024, 0x61);
    const bigHeader = Buffer.alloc(5);
    bigHeader.writeUInt8(0, 0);
    bigHeader.writeUInt32BE(bigPayload.length, 1);
    const bigAcc = streamSub.createConnectFrameAccumulator({ maxFrameBytes: Infinity, rawOnly: true });
    assert.deepEqual(bigAcc.push(bigHeader), []);
    assert.deepEqual(bigAcc.push(bigPayload.subarray(0, 8 * 1024 * 1024)), []);
    const bigOut = bigAcc.push(bigPayload.subarray(8 * 1024 * 1024));
    assert.equal(bigOut.length, 1);
    assert.equal(bigOut[0].raw.length, 18 * 1024 * 1024);
  });
});

