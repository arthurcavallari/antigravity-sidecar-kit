/**
 * @fileoverview Zero-dependency Connect-RPC 5-byte binary framing and RFC 6455 WebSocket
 * upgrade, framing, and token-authenticated streaming helpers.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { isLoopbackOrigin } from './state-sync.mjs';

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024; // 16 MiB

function toPayloadBuffer(payload, fallbackJson = {}) {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof Uint8Array) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (typeof payload === 'string') return Buffer.from(payload, 'utf8');
  return Buffer.from(JSON.stringify(payload ?? fallbackJson), 'utf8');
}

/**
 * Serializes a JSON object, string, or Buffer into a 5-byte Connect frame:
 * `[1B flags][4B UInt32BE length][payload]`.
 *
 * @param {any} payload
 * @param {number} [flags=0]
 * @returns {Buffer}
 */
export function encodeConnectFrame(payload, flags = 0) {
  const body = toPayloadBuffer(payload, {});
  const frame = Buffer.allocUnsafe(5 + body.length);
  frame.writeUInt8(flags & 0xff, 0);
  frame.writeUInt32BE(body.length >>> 0, 1);
  body.copy(frame, 5);
  return frame;
}

function decodeRawConnectPayload(raw) {
  const text = raw.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return Buffer.byteLength(text, 'utf8') === raw.length && Buffer.from(text, 'utf8').equals(raw) ? text : raw;
  }
}

function peekConnectLength(chunks) {
  if (chunks[0].length >= 5) return chunks[0].readUInt32BE(1);
  const hdr = Buffer.allocUnsafe(5);
  let copied = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, 5 - copied);
    c.copy(hdr, copied, 0, take);
    copied += take;
    if (copied === 5) break;
  }
  return hdr.readUInt32BE(1);
}

/**
 * Parses complete 5-byte Connect frames from a Buffer/Uint8Array and returns
 * any trailing incomplete bytes in `rest` (aliased as `remaining`).
 *
 * @param {Buffer|Uint8Array} buffer
 * @param {{ maxFrameBytes?: number, rawOnly?: boolean }} [options]
 * @returns {{ frames: Array<{ flags: number, data: any, raw: Buffer }>, rest: Buffer, remaining: Buffer }}
 */
export function parseConnectFrames(buffer, { maxFrameBytes = DEFAULT_MAX_FRAME_BYTES, rawOnly = false } = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const frames = [];
  let offset = 0;

  while (offset + 5 <= buf.length) {
    const flags = buf.readUInt8(offset);
    const length = buf.readUInt32BE(offset + 1);
    if (length > maxFrameBytes) {
      throw new RangeError(`Connect frame length (${length}) exceeds maxFrameBytes (${maxFrameBytes})`);
    }
    if (offset + 5 + length > buf.length) break;

    const raw = Buffer.from(buf.subarray(offset + 5, offset + 5 + length));
    offset += 5 + length;

    if (flags & 0x01) {
      frames.push({ flags, data: raw, raw });
    } else if (rawOnly && flags === 0) {
      let parsed;
      let decoded = false;
      frames.push({
        flags,
        raw,
        get data() {
          if (!decoded) {
            decoded = true;
            parsed = decodeRawConnectPayload(raw);
          }
          return parsed;
        },
      });
    } else {
      frames.push({ flags, data: decodeRawConnectPayload(raw), raw });
    }
  }

  const remaining = buf.subarray(offset);
  Object.defineProperty(frames, 'remaining', { value: remaining, enumerable: false });
  return { frames, rest: remaining, remaining };
}

/**
 * Decodes a single 5-byte Connect frame from the start of `buffer`, returning `null` if incomplete.
 *
 * @param {Buffer|Uint8Array} buffer
 * @param {{ maxFrameBytes?: number, rawOnly?: boolean }} [options]
 * @returns {{ flags: number, data: any, raw: Buffer, rest: Buffer } | null}
 */
export function decodeConnectFrame(buffer, options) {
  const { frames, rest } = parseConnectFrames(buffer, options);
  return frames[0] ? { ...frames[0], rest } : null;
}

/**
 * Creates a stateful Connect-RPC frame accumulator for streaming chunks.
 * Defers Buffer.concat until at least one full Connect frame is buffered (O(N) assembly).
 *
 * @param {{ maxFrameBytes?: number, rawOnly?: boolean }} [options]
 */
export function createConnectFrameAccumulator({ maxFrameBytes = DEFAULT_MAX_FRAME_BYTES, rawOnly = false } = {}) {
  let chunks = [];
  let totalLen = 0;
  return {
    push(chunk) {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || []);
      if (next.length > 0) {
        chunks.push(next);
        totalLen += next.length;
      }
      if (totalLen < 5) return [];
      const firstLen = peekConnectLength(chunks);
      if (firstLen > maxFrameBytes) {
        throw new RangeError(`Connect frame length (${firstLen}) exceeds maxFrameBytes (${maxFrameBytes})`);
      }
      if (totalLen < 5 + firstLen) return [];
      const merged = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, totalLen);
      const { frames, rest } = parseConnectFrames(merged, { maxFrameBytes, rawOnly });
      chunks = rest.length > 0 ? [rest] : [];
      totalLen = rest.length;
      return frames;
    },
    reset() {
      chunks = [];
      totalLen = 0;
    },
    get remaining() {
      if (chunks.length === 0) return Buffer.alloc(0);
      if (chunks.length > 1) chunks = [Buffer.concat(chunks, totalLen)];
      return chunks[0];
    },
  };
}

/**
 * Encodes a server-to-client RFC 6455 WebSocket frame (7-bit, 16-bit, or 64-bit payload length).
 *
 * @param {string|Buffer|Uint8Array|object} payload
 * @param {number} [opcode=0x01]
 * @returns {Buffer}
 */
export function encodeWsFrame(payload, opcode = 0x01) {
  const body =
    payload === undefined || payload === null ? Buffer.alloc(0) : toPayloadBuffer(payload, '');
  const len = body.length;
  const firstByte = 0x80 | (opcode & 0x0f);

  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header.writeUInt8(firstByte, 0);
    header.writeUInt8(len, 1);
  } else if (len <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header.writeUInt8(firstByte, 0);
    header.writeUInt8(126, 1);
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header.writeUInt8(firstByte, 0);
    header.writeUInt8(127, 1);
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  const out = Buffer.allocUnsafe(header.length + len);
  header.copy(out, 0);
  body.copy(out, header.length);
  return out;
}

/**
 * Decodes RFC 6455 WebSocket frames from a Buffer/Uint8Array, supporting 7-bit, 16-bit, and
 * 64-bit payload lengths and unmasking client-to-server 4-byte XOR masks in place.
 *
 * @param {Buffer|Uint8Array} buffer
 * @param maxFrameBytes
 * @returns {{ frames: Array<{ fin: boolean, opcode: number, payload: Buffer }>, rest: Buffer }}
 */
export function decodeWsFrames(buffer, { maxFrameBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const frames = [];
  let offset = 0;

  while (offset + 2 <= buf.length) {
    const b0 = buf.readUInt8(offset);
    const b1 = buf.readUInt8(offset + 1);
    const fin = Boolean(b0 & 0x80);
    const opcode = b0 & 0x0f;
    const masked = Boolean(b1 & 0x80);
    let payloadLen = b1 & 0x7f;
    let headerLen = 2;

    if (payloadLen === 126) {
      headerLen = 4;
      if (offset + headerLen > buf.length) break;
      payloadLen = buf.readUInt16BE(offset + 2);
    } else if (payloadLen === 127) {
      headerLen = 10;
      if (offset + headerLen > buf.length) break;
      const bigLen = buf.readBigUInt64BE(offset + 2);
      if (bigLen > BigInt(maxFrameBytes)) {
        throw new RangeError(`WebSocket frame length (${bigLen}) exceeds maxFrameBytes (${maxFrameBytes})`);
      }
      payloadLen = Number(bigLen);
    }

    if (payloadLen > maxFrameBytes) {
      throw new RangeError(`WebSocket frame length (${payloadLen}) exceeds maxFrameBytes (${maxFrameBytes})`);
    }

    const maskOffset = offset + headerLen;
    if (masked) headerLen += 4;
    if (offset + headerLen + payloadLen > buf.length) break;

    const payloadStart = offset + headerLen;
    const payloadEnd = payloadStart + payloadLen;
    const payload = Buffer.from(buf.subarray(payloadStart, payloadEnd));

    if (masked) {
      const m0 = buf[maskOffset];
      const m1 = buf[maskOffset + 1];
      const m2 = buf[maskOffset + 2];
      const m3 = buf[maskOffset + 3];
      const mask = [m0, m1, m2, m3];
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= mask[i & 3];
      }
    }

    frames.push({ fin, opcode, payload });
    offset = payloadEnd;
  }

  return { frames, rest: buf.subarray(offset) };
}

/**
 * Attaches an RFC 6455 WebSocket upgrade handler to an HTTP server at `pathname`.
 *
 * @param {import('node:http').Server} server
 * @param {string} pathname
 * @param {{ verifyToken?: boolean, onConnection?: (wsClient: object, req: import('node:http').IncomingMessage) => void }} [options]
 */
export function attachWebSocketRoute(
  server,
  pathname,
  { verifyToken = true, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES, onConnection } = {}
) {
  const handleUpgrade = (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      return;
    }
    if (pathname && url.pathname !== pathname) return;

    if (!isLoopbackOrigin(req.headers?.origin)) {
      try {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      } catch {}
      if (typeof socket.destroySoon === 'function') socket.destroySoon();
      else socket.destroy();
      return;
    }

    const expectedToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';
    if (verifyToken && expectedToken) {
      const rawHeaderTok = req.headers?.['x-sidecar-token'] ?? req.headers?.['X-Sidecar-Token'];
      const headerTok = Array.isArray(rawHeaderTok) ? rawHeaderTok[0] : rawHeaderTok;
      const provided = String(url.searchParams.get('token') || headerTok || '');
      const a = Buffer.from(provided, 'utf8');
      const b = Buffer.from(expectedToken, 'utf8');
      const digestA = createHash('sha256').update(a).digest();
      const digestB = createHash('sha256').update(b).digest();
      if (!timingSafeEqual(digestA, digestB) || a.byteLength !== b.byteLength) {
        try {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        } catch {}
        if (typeof socket.destroySoon === 'function') socket.destroySoon();
        else socket.destroy();
        return;
      }
    }

    const wsKey = req.headers?.['sec-websocket-key'];
    if (!wsKey || typeof wsKey !== 'string') {
      try {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      } catch {}
      if (typeof socket.destroySoon === 'function') socket.destroySoon();
      else socket.destroy();
      return;
    }

    const accept = createHash('sha1')
      .update(wsKey.trim() + WS_GUID)
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    const messageListeners = [];
    const closeListeners = [];
    let closed = false;
    let recvBuf = Buffer.alloc(0);
    let fragOpcode = 0;
    let fragChunks = [];

    const fireClose = () => {
      if (closed) return;
      closed = true;
      for (const cb of closeListeners) {
        try {
          cb();
        } catch {}
      }
    };

    const writeRawFrame = (frameBuf) => {
      if (closed || socket.destroyed) return false;
      try {
        socket.write(frameBuf);
        return true;
      } catch {
        return false;
      }
    };

    const wsClient = {
      sendText(str) {
        return writeRawFrame(encodeWsFrame(String(str ?? ''), 0x01));
      },
      sendBinary(buf) {
        const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
        return writeRawFrame(encodeWsFrame(b, 0x02));
      },
      sendJson(obj) {
        return writeRawFrame(encodeWsFrame(JSON.stringify(obj ?? null), 0x01));
      },
      close() {
        if (!closed && !socket.destroyed) {
          try {
            socket.write(encodeWsFrame(Buffer.alloc(0), 0x08));
            socket.end();
          } catch {}
          socket.destroy();
        }
        fireClose();
      },
      onMessage(cb) {
        if (typeof cb === 'function') messageListeners.push(cb);
        return wsClient;
      },
      onClose(cb) {
        if (typeof cb === 'function') closeListeners.push(cb);
        return wsClient;
      },
    };

    const processChunk = (chunk) => {
      if (closed || !chunk || chunk.length === 0) return;
      recvBuf = Buffer.concat([recvBuf, chunk]);
      let decoded;
      try {
        decoded = decodeWsFrames(recvBuf, { maxFrameBytes });
      } catch {
        wsClient.close();
        return;
      }
      const { frames, rest } = decoded;
      if (rest.length > maxFrameBytes + 14) {
        wsClient.close();
        return;
      }
      recvBuf = rest;

      for (const frame of frames) {
        if (frame.opcode === 0x09) {
          // Ping -> automatic Pong (0x0A)
          writeRawFrame(encodeWsFrame(frame.payload, 0x0a));
        } else if (frame.opcode === 0x08) {
          // Close
          wsClient.close();
          return;
        } else if (frame.opcode === 0x01 || frame.opcode === 0x02 || frame.opcode === 0x00) {
          let effectiveOpcode = frame.opcode;
          let payload = frame.payload;
          if (!frame.fin) {
            if (frame.opcode !== 0x00) fragOpcode = frame.opcode;
            fragChunks.push(frame.payload);
            if (fragChunks.reduce((n, b) => n + b.length, 0) > maxFrameBytes) {
              wsClient.close();
              return;
            }
            continue;
          } else if (frame.opcode === 0x00 && fragChunks.length > 0) {
            fragChunks.push(frame.payload);
            payload = Buffer.concat(fragChunks);
            if (payload.length > maxFrameBytes) {
              wsClient.close();
              return;
            }
            effectiveOpcode = fragOpcode || 0x02;
            fragChunks = [];
            fragOpcode = 0;
          }
          const data = effectiveOpcode === 0x01 ? payload.toString('utf8') : payload;
          for (const cb of messageListeners) {
            try {
              cb(data, frame);
            } catch {}
          }
        }
      }
    };

    socket.on('data', processChunk);
    socket.on('close', fireClose);
    socket.on('end', fireClose);
    socket.on('error', () => {
      fireClose();
    });

    if (typeof onConnection === 'function') {
      onConnection(wsClient, req);
    }

    if (head && head.length > 0) {
      processChunk(head);
    }
  };

  server.on('upgrade', handleUpgrade);
  return {
    close() {
      server.off?.('upgrade', handleUpgrade);
    },
  };
}
