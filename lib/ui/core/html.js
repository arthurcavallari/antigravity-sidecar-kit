(function (win) {
  const doc = win.document;
  const ui = (win.AgyUI = win.AgyUI || {});

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SVG_TAGS = new Set([
    'svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse',
    'g', 'defs', 'linearGradient', 'radialGradient', 'stop', 'use', 'clipPath',
    'mask', 'pattern', 'text', 'tspan', 'foreignObject',
  ]);
  const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const BOOL_ATTRS = new Set(['disabled', 'checked', 'hidden', 'selected', 'readonly', 'multiple', 'autofocus', 'required']);
  const TEMPLATE_CACHE = new WeakMap();
  const SLOT_RE = /\x00(\d+)\x00/g;

  ui.escHtml = function escHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };
  ui.esc = ui.escHtml;

  ui.clear = function clear(el) {
    if (!el) return;
    if (typeof el.replaceChildren === 'function') el.replaceChildren();
    else el.innerHTML = '';
  };

  function appendChildVal(parent, ch) {
    if (ch === null || ch === undefined || typeof ch === 'boolean' || (typeof ch === 'number' && Number.isNaN(ch))) return;
    if (Array.isArray(ch) || (typeof ch === 'object' && !ch.nodeType && typeof ch[Symbol.iterator] === 'function')) {
      for (const item of ch) appendChildVal(parent, item);
      return;
    }
    if (typeof ch === 'object' && (ch.nodeType || typeof ch.appendChild === 'function')) {
      parent.appendChild(ch);
      return;
    }
    if (typeof doc?.createTextNode === 'function') parent.appendChild(doc.createTextNode(String(ch)));
    else if (parent) parent.textContent = (parent.textContent || '') + String(ch);
  }

  function resolveEventName(key) {
    if (key.startsWith('on-')) return key.slice(3);
    if (/^on(Tab|Split)[A-Z]/.test(key)) {
      return key.slice(2).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/context-menu/g, 'contextmenu');
    }
    return key.slice(2).toLowerCase();
  }

  ui.el = function el(tag, attrs = {}, ...rest) {
    if (!tag || tag === 'fragment') {
      const frag = typeof doc.createDocumentFragment === 'function' ? doc.createDocumentFragment() : doc.createElement('div');
      appendChildVal(frag, attrs);
      for (const r of rest) appendChildVal(frag, r);
      return frag;
    }
    let props = attrs;
    let children = rest;
    if (
      Array.isArray(attrs) ||
      typeof attrs === 'string' ||
      typeof attrs === 'number' ||
      (attrs && typeof attrs === 'object' && attrs.nodeType)
    ) {
      props = {};
      children = [attrs, ...rest];
    }
    const isSvg = SVG_TAGS.has(tag);
    const node = isSvg && typeof doc.createElementNS === 'function' ? doc.createElementNS(SVG_NS, tag) : doc.createElement(tag);
    for (const [key, val] of Object.entries(props || {})) {
      if (key.startsWith('.')) {
        node[key.slice(1)] = val;
        continue;
      }
      if (key.startsWith('?')) {
        const attrName = key.slice(1);
        if (val && !Number.isNaN(val)) node.setAttribute?.(attrName, '');
        else node.removeAttribute?.(attrName);
        continue;
      }
      if (key.startsWith('on') && key.length > 2) {
        if (typeof val === 'function') node.addEventListener?.(resolveEventName(key), val);
        continue;
      }
      if (key === 'ref') {
        if (typeof val === 'function') val(node);
        else if (val && typeof val === 'object') val.current = node;
        continue;
      }
      if (key === 'className' || key === 'class') {
        if (val && !Number.isNaN(val)) {
          if (isSvg) node.setAttribute?.('class', String(val));
          else node.className = String(val);
        } else {
          if (!isSvg) node.className = '';
          node.removeAttribute?.('class');
        }
        continue;
      }
      if (val === undefined || val === null || (typeof val === 'number' && Number.isNaN(val))) continue;
      if (key === 'dataset' && typeof val === 'object') {
        for (const [dk, dv] of Object.entries(val)) {
          if (dv !== undefined && dv !== null && !(typeof dv === 'number' && Number.isNaN(dv))) node.dataset[dk] = String(dv);
        }
      } else if (key === 'style') {
        if (typeof val === 'string') {
          node.setAttribute?.('style', val);
          if (node.style) node.style.cssText = val;
        } else if (typeof val === 'object') {
          for (const [sk, sv] of Object.entries(val)) {
            if (sv === undefined || sv === null || sv === false || (typeof sv === 'number' && Number.isNaN(sv))) continue;
            if (sk.startsWith('--') && typeof node.style?.setProperty === 'function') node.style.setProperty(sk, String(sv));
            else if (node.style) node.style[sk] = String(sv);
          }
        }
      } else if (key === 'innerHTML') {
        node.innerHTML = String(val);
      } else if (key === 'textContent') {
        node.textContent = String(val);
      } else if (key === 'tabIndex' || key === 'tabindex') {
        node.setAttribute?.('tabindex', String(val));
        try { node.tabIndex = Number(val); } catch {}
      } else if (BOOL_ATTRS.has(key)) {
        if (val) {
          node.setAttribute?.(key, '');
          try { node[key] = true; } catch {}
        } else {
          node.removeAttribute?.(key);
          try { node[key] = false; } catch {}
        }
      } else if (typeof val === 'boolean') {
        if (key.startsWith('aria-') || key.startsWith('data-')) node.setAttribute?.(key, String(val));
        else if (val) node.setAttribute?.(key, '');
        else node.removeAttribute?.(key);
      } else if (!isSvg && (typeof val === 'object' || typeof val === 'function')) {
        node[key] = val;
      } else {
        node.setAttribute?.(key, String(val));
      }
    }
    for (const ch of children) appendChildVal(node, ch);
    return node;
  };
  ui.h = ui.el;

  function splitWithSlots(str) {
    const parts = [];
    let last = 0;
    for (const m of str.matchAll(SLOT_RE)) {
      if (m.index > last) parts.push({ type: 'text', value: str.slice(last, m.index) });
      parts.push({ type: 'slot', index: Number(m[1]) });
      last = m.index + m[0].length;
    }
    if (last < str.length) parts.push({ type: 'text', value: str.slice(last) });
    return parts;
  }

  function parseAttrs(rawAttrStr) {
    const attrs = [];
    const re = /([.?]?[a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\x00(\d+)\x00|([^\s"'=<>`]+)))?/g;
    for (const m of rawAttrStr.matchAll(re)) {
      const name = m[1];
      if (m[4] !== undefined) {
        attrs.push({ name, type: 'slot', index: Number(m[4]) });
      } else if (m[2] !== undefined || m[3] !== undefined || m[5] !== undefined) {
        const rawVal = m[2] ?? m[3] ?? m[5];
        const parts = splitWithSlots(rawVal);
        if (parts.length === 1 && parts[0].type === 'slot') attrs.push({ name, type: 'slot', index: parts[0].index });
        else if (parts.every((p) => p.type === 'text')) attrs.push({ name, type: 'static', value: rawVal });
        else attrs.push({ name, type: 'mixed', parts });
      } else {
        attrs.push({ name, type: 'static', value: true });
      }
    }
    return attrs;
  }

  function compileTemplate(strings) {
    let joined = '';
    for (let i = 0; i < strings.length; i++) {
      joined += strings[i] + (i < strings.length - 1 ? `\x00${i}\x00` : '');
    }
    const root = { type: 'fragment', children: [] };
    const stack = [root];
    const tagRe = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9_-]*)>|<>|<([a-zA-Z][a-zA-Z0-9_-]*)((?:\s+(?:[^<>"'/]|"[^"]*"|'[^']*'|\/(?!>))*?)?)(\s*\/?)>/g;
    let lastIdx = 0;

    const pushTextSegment = (seg) => {
      for (const p of splitWithSlots(seg)) {
        if (p.type === 'text' && stack.length === 1 && !p.value.trim()) continue;
        stack[stack.length - 1].children.push(p);
      }
    };

    for (const m of joined.matchAll(tagRe)) {
      if (m.index > lastIdx) pushTextSegment(joined.slice(lastIdx, m.index));
      lastIdx = m.index + m[0].length;
      if (m[0].startsWith('<!--')) continue;
      if (m[0].startsWith('</')) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const tag = m[2] || 'fragment';
      const selfClose = Boolean(m[4]?.trim() === '/') || VOID_TAGS.has(tag.toLowerCase());
      const node = { type: tag === 'fragment' ? 'fragment' : 'element', tag, attrs: parseAttrs(m[3] || ''), children: [] };
      stack[stack.length - 1].children.push(node);
      if (!selfClose) stack.push(node);
    }
    if (lastIdx < joined.length) pushTextSegment(joined.slice(lastIdx));
    return root;
  }

  function instantiateAst(ast, values) {
    if (ast.type === 'text') return typeof doc?.createTextNode === 'function' ? doc.createTextNode(ast.value) : ast.value;
    if (ast.type === 'slot') return values[ast.index];
    if (ast.type === 'fragment') {
      const frag = typeof doc.createDocumentFragment === 'function' ? doc.createDocumentFragment() : doc.createElement('div');
      for (const ch of ast.children) appendChildVal(frag, instantiateAst(ch, values));
      return frag;
    }
    const props = {};
    for (const a of ast.attrs) {
      if (a.type === 'static') props[a.name] = a.value;
      else if (a.type === 'slot') props[a.name] = values[a.index];
      else props[a.name] = a.parts.map((p) => (p.type === 'text' ? p.value : String(values[p.index] ?? ''))).join('');
    }
    return ui.el(ast.tag, props, ast.children.map((c) => instantiateAst(c, values)));
  }

  ui.html = function html(strings, ...values) {
    let ast = TEMPLATE_CACHE.get(strings);
    if (!ast) {
      ast = compileTemplate(strings);
      TEMPLATE_CACHE.set(strings, ast);
    }
    return ast.children.length === 1 && ast.children[0].type === 'element'
      ? instantiateAst(ast.children[0], values)
      : instantiateAst(ast, values);
  };
  ui.html._cache = TEMPLATE_CACHE;
})(typeof window !== 'undefined' ? window : globalThis);
