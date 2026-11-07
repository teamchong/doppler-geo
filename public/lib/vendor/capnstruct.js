import { generateGo, generateRust, toGoStruct, toRustReprC, } from './codegen.js';
export { generateGo, generateRust, toGoStruct, toRustReprC, };
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const oob = () => {
    throw new RangeError('Out of bounds');
};
const al = (x, a) => (x + a - 1) & ~(a - 1);
const u8s = (d, o = 0, l = d.byteLength - o) => new Uint8Array(d.buffer, d.byteOffset + o, l);
const N = Number;
const chkLen = (n) => {
    if (!N.isInteger(n) || n < 0)
        oob();
};
let sBuf = new ArrayBuffer(65536), sDv = new DataView(sBuf), sU8 = new Uint8Array(sBuf), tail = 0;
function hid(value) {
    return { value, writable: true, enumerable: false, configurable: true };
}
const BASE_DESCS = Object.fromEntries(['_d', '_o', '_b', '_m', '_a', '_ws', '_tl', '_dead', '_dirty'].map((k) => [k, hid()]));
function prim(type, _C, _g, _s) {
    const c = type[0], size = (+type.slice(1) || 8) >> 3, float = c === 'f';
    return {
        kind: 'primitive',
        type,
        rustType: (type === 'f16' ? 'u16' : type),
        size,
        align: size,
        signed: c === 'i' || float,
        float,
        bigint: size === 8 && !float,
        _C,
        _g,
        _s,
    };
}
/** Unsigned 8-bit integer (`0..255`, 1 byte, 1-byte aligned). */
export const u8 = prim('u8', Uint8Array, (d, o) => d.getUint8(o), (d, o, v) => d.setUint8(o, N(v)));
/** Signed 8-bit integer (`-128..127`, 1 byte, 1-byte aligned). */
export const i8 = prim('i8', Int8Array, (d, o) => d.getInt8(o), (d, o, v) => d.setInt8(o, N(v)));
/** Little-endian unsigned 16-bit integer (`0..65535`, 2 bytes, 2-byte aligned). */
export const u16 = prim('u16', Uint16Array, (d, o) => d.getUint16(o, true), (d, o, v) => d.setUint16(o, N(v), true));
/** Little-endian signed 16-bit integer (`-32768..32767`, 2 bytes, 2-byte aligned). */
export const i16 = prim('i16', Int16Array, (d, o) => d.getInt16(o, true), (d, o, v) => d.setInt16(o, N(v), true));
/** Little-endian unsigned 32-bit integer (4 bytes, 4-byte aligned). */
export const u32 = prim('u32', Uint32Array, (d, o) => d.getUint32(o, true), (d, o, v) => d.setUint32(o, N(v), true));
/** Little-endian signed 32-bit integer (4 bytes, 4-byte aligned). */
export const i32 = prim('i32', Int32Array, (d, o) => d.getInt32(o, true), (d, o, v) => d.setInt32(o, N(v), true));
/** Little-endian unsigned 64-bit integer (`bigint`, 8 bytes, 8-byte aligned). */
export const u64 = prim('u64', BigUint64Array, (d, o) => d.getBigUint64(o, true), (d, o, v) => d.setBigUint64(o, BigInt(v), true));
/** Little-endian signed 64-bit integer (`bigint`, 8 bytes, 8-byte aligned). */
export const i64 = prim('i64', BigInt64Array, (d, o) => d.getBigInt64(o, true), (d, o, v) => d.setBigInt64(o, BigInt(v), true));
/** IEEE 754 16-bit half-precision float (2 bytes, 2-byte aligned). */
export const f16 = /* @__PURE__ */ (() => prim('f16', globalThis.Float16Array ?? Uint16Array, (d, o) => d.getFloat16(o, true), (d, o, v) => d.setFloat16(o, N(v), true)))();
/** IEEE 754 32-bit float (4 bytes, 4-byte aligned). */
export const f32 = prim('f32', Float32Array, (d, o) => d.getFloat32(o, true), (d, o, v) => d.setFloat32(o, N(v), true));
/** IEEE 754 64-bit float (8 bytes, 8-byte aligned). */
export const f64 = prim('f64', Float64Array, (d, o) => d.getFloat64(o, true), (d, o, v) => d.setFloat64(o, N(v), true));
/** 1-byte boolean (`0` or `1`, 1-byte aligned). */
export const bool = prim('bool', Uint8Array, (d, o) => d.getUint8(o) !== 0, (d, o, v) => d.setUint8(o, v ? 1 : 0));
/** Inline fixed-length null-padded UTF-8 string `[u8; N]` (`align: 1, size: length`) with zero tail indirection. */
export function fixedStr(length) {
    chkLen(length);
    return {
        kind: 'primitive',
        type: 'fixedStr',
        length,
        size: length,
        align: 1,
        rustType: `[u8; ${length}]`,
        _C: undefined,
        _g(d, o) {
            let end = 0, s = '';
            for (; end < length; end++) {
                const c = d.getUint8(o + end);
                if (!c)
                    break;
                if (c < 0x80 && s !== null)
                    s += String.fromCharCode(c);
                else
                    s = null;
            }
            return s !== null ? s : textDecoder.decode(u8s(d, o, end));
        },
        _s(d, o, v) {
            const u = u8s(d, o, length), w = v ? textEncoder.encodeInto(String(v), u).written : 0;
            if (w < length)
                u.fill(0, w);
        },
    };
}
/** Inline fixed-length byte array `[u8; N]` (`align: 1, size: length`) read as a zero-copy `Uint8Array`. */
export function fixedBytes(length) {
    chkLen(length);
    return {
        kind: 'primitive',
        type: 'fixedBytes',
        length,
        size: length,
        align: 1,
        rustType: `[u8; ${length}]`,
        _C: undefined,
        _g: (d, o) => u8s(d, o, length),
        _s(d, o, v) {
            const u = u8s(d, o, length);
            u.fill(0);
            if (v) {
                u.set(ArrayBuffer.isView(v)
                    ? u8s(v, 0, Math.min(v.byteLength, length))
                    : Array.from(v).slice(0, length));
            }
        },
    };
}
/** Maps an inline sentinel value (e.g. `-32768` for `i16` or `NaN` for `f32`) to `null` in JS with 0 extra wire bytes. */
export function sentinel(primDesc, nullValue) {
    const isNan = typeof nullValue === 'number' && Number.isNaN(nullValue);
    return {
        ...primDesc,
        nullable: true,
        _null: nullValue,
        _C: undefined,
        _g: (d, o) => {
            const v = primDesc._g(d, o);
            return (isNan ? Number.isNaN(v) : v === nullValue) ? null : v;
        },
        _s: (d, o, v) => primDesc._s(d, o, (v == null ? nullValue : v)),
    };
}
/** Alias for `sentinel(primDesc, nullValue)`. */
export const nullable = sentinel;
export function scaled(primDesc, factor, nullOpt) {
    const nv = typeof nullOpt === 'number' ? nullOpt : nullOpt?.null, hasN = nv !== undefined;
    return {
        ...primDesc,
        type: 'f64',
        float: true,
        nullable: hasN,
        _null: nv,
        _C: undefined,
        _g: (d, o) => {
            const r = primDesc._g(d, o);
            return hasN && r === nv ? null : r / factor;
        },
        _s: (d, o, v) => primDesc._s(d, o, v == null && hasN ? nv : Math.round(+N(v) * factor)),
    };
}
/** Variable-length UTF-8 string stored in the tail arena via an 8-byte `[u32 off, u32 len]` descriptor. */
export const str = {
    kind: 'str',
    size: 8,
    align: 4,
    rustType: 'CapnStr',
};
export function fixedArray(element, length) {
    chkLen(length);
    return {
        kind: 'array',
        element,
        length,
        size: element.size * length,
        align: element.align,
        rustType: `[${element.rustType}; ${length}]`,
    };
}
/** Alias for `fixedArray(element, length)`. */
export const array = fixedArray;
export function slice(element, kind = 'slice') {
    const getEl = () => (typeof element === 'function' ? element() : element);
    return {
        kind: kind,
        get element() {
            return getEl();
        },
        size: 8,
        align: 4,
        get rustType() {
            return `Capn${kind === 'ref' ? 'Ref' : 'Slice'}<${getEl().rustType}>`;
        },
    };
}
/** Alias for `slice(element)`. */
export const list = slice;
export function ref(target) {
    return slice(target, 'ref');
}
function ensureScratch(minBytes) {
    if (minBytes > sBuf.byteLength) {
        const nb = new ArrayBuffer(Math.max(minBytes, sBuf.byteLength * 2));
        sDv = new DataView((sBuf = nb));
        const nu = new Uint8Array(nb);
        nu.set(sU8);
        sU8 = nu;
    }
}
function isWasmMemory(x) {
    return typeof WebAssembly !== 'undefined' && x instanceof WebAssembly.Memory;
}
function isMemOrArena(x) {
    return (typeof x === 'object' && x !== null && '_u8' in x) || isWasmMemory(x);
}
function resolveSource(s, byteOffset = 0) {
    const v = ArrayBuffer.isView(s);
    const m = isMemOrArena(s) ? s : null;
    const b = v ? s.buffer : m ? m.buffer : s;
    const len = v ? s.byteLength : b.byteLength;
    if (byteOffset < 0 || byteOffset > len)
        oob();
    return {
        d: s instanceof DataView
            ? s
            : v
                ? new DataView(b, s.byteOffset, len)
                : m && '_d' in m
                    ? m.sync()._d
                    : new DataView(b),
        o: byteOffset,
        max: len - byteOffset,
        m,
    };
}
function defVal(desc, plain) {
    const d = new DataView(new ArrayBuffer(desc.size));
    return readVal({ def: desc, _d: d, _b: 0, _o: 0, _ws: desc.size, _m: null, _k: () => d }, desc, 0, plain);
}
function allocTail(v, bytes, align) {
    const root = v._a ?? v, m = root._m;
    if (m && '_u8' in m) {
        const p = m._alloc(bytes, align, true);
        if (root._tl !== undefined && m.offset > root._tl)
            root._tl = m.offset;
        v._d = root._d = m._d;
        return p;
    }
    const d = root._k(), cur = root._tl ?? root._o + root.byteLength, p = al(cur, align), end = p + bytes;
    if (end > d.byteLength) {
        if (m) {
            m.grow(Math.ceil((end - d.byteLength) / 65536));
            root._d = new DataView(m.buffer);
        }
        else {
            const nb = new ArrayBuffer(Math.max(end, d.byteLength * 2, 64));
            new Uint8Array(nb).set(u8s(d, 0, cur));
            root._d = new DataView(nb);
        }
        v._d = root._d;
        if (root._c)
            root._c._d = root._d;
        if (root._p)
            for (const pv of root._p)
                if (pv)
                    pv._d = root._d;
    }
    else if (bytes) {
        u8s(d, p, bytes).fill(0);
    }
    root._tl = end;
    return p;
}
function mutVar(v, off, base, count, elSize, align) {
    const root = v._a ?? v;
    let d = v._k();
    const oldP = d.getUint32(off, true), oldB = d.getUint32(off + 4, true) * elSize, bytes = count * elSize, cur = root._tl ?? root._o + root.byteLength;
    let st = base + oldP;
    const atTip = oldB > 0 && st + oldB === cur;
    if (bytes <= oldB) {
        if (oldB > bytes) {
            if (atTip && !root._m)
                root._tl = st + bytes;
            else
                root._dead = (root._dead ?? 0) + (oldB - bytes);
        }
    }
    else {
        if (atTip) {
            root._tl = st;
            if (root._m && '_u8' in root._m && root._m.offset === cur)
                root._m.offset = st;
        }
        else if (oldB) {
            root._dead = (root._dead ?? 0) + oldB;
        }
        st = allocTail(root, bytes, align);
        d = v._d = root._d;
    }
    if (root.def && off === root._b + root.def._fv && st - base !== oldP)
        root._dirty = true;
    if (bytes)
        u8s(d, st, bytes).fill(0);
    setDesc(off, count ? st - base : 0, count, d);
    return st;
}
function upgradeView(v) {
    if (v._ws < v.def.size)
        (v._a ?? v).compact();
}
let _budget = 0;
let _rSeen = null;
let _wSeen = null;
let _wActive = null;
let _wFix = null;
function readVal(v, desc, off, plain, len) {
    const d = v._k(), k = desc.kind;
    if (len !== undefined) {
        const sz = desc.size, tot = d.byteOffset + off;
        if (!plain && k === 'primitive' && desc._C && desc.type !== 'bool' && tot % sz === 0) {
            return new desc._C(d.buffer, tot, len);
        }
        if (!plain && k === 'struct') {
            const sav = new StructArrayView(desc, d, off, len, v._b);
            sav._m = v._m;
            sav._a = v._a ?? v;
            return sav;
        }
        if (plain && (_budget -= len * sz) < 0)
            oob();
        return Array.from({ length: len }, (_, i) => readVal(v, desc, off + i * sz, plain));
    }
    if (k === 'primitive') {
        const r = desc._g(d, off);
        return plain && r instanceof Uint8Array ? Array.from(r) : r;
    }
    const minP = v._o === v._b ? v._o + v._ws : v._b;
    if (k === 'str') {
        const p = v._b + d.getUint32(off, true), l = d.getUint32(off + 4, true);
        if (!l)
            return '';
        if (p < minP ||
            p + l > d.byteLength ||
            (p < off + 8 && p + l > off) ||
            (plain && (_budget -= l) < 0))
            oob();
        let s = '';
        if (l <= 48) {
            for (let i = 0; i < l; i++) {
                const c = d.getUint8(p + i);
                if (c >= 0x80) {
                    s = '';
                    break;
                }
                s += String.fromCharCode(c);
            }
        }
        return s || textDecoder.decode(u8s(d, p, l));
    }
    if (k === 'array' || k === 'slice' || k === 'ref') {
        const el = desc.element, n = k === 'array' ? desc.length : d.getUint32(off + 4, true);
        if (k === 'ref' && !n)
            return null;
        let p = off;
        if (k !== 'array') {
            if (!n)
                p = v._o;
            else {
                p = v._b + d.getUint32(off, true);
                const bl = (k === 'ref' ? 1 : n) * el.size, inTbl = el === v.def && p >= v._b && (p - v._b) % (v._ws || v.def.size) === 0;
                if ((!inTbl && p < minP) || p + bl > d.byteLength || (!inTbl && p < off + 8 && p + bl > off))
                    oob();
            }
        }
        return readVal(v, el, p, plain, k === 'ref' ? undefined : n);
    }
    if (!plain) {
        if (desc === v.def && v === v._a?._c) {
            v._o = off;
            return v;
        }
        const nv = new desc._V(d, v._b, off, v._m);
        nv._ws = desc === v.def ? v._ws : desc.size;
        nv._a = v._a ?? v;
        return nv;
    }
    const prev = _rSeen?.get(off);
    if (prev)
        return prev;
    const ws = desc === v.def ? (v._ws ?? desc.size) : desc.size;
    if ((_budget -= ws) < 0)
        oob();
    const out = {};
    _rSeen?.set(off, out);
    for (const f of desc.fieldList) {
        out[f.name] =
            f.offset + f.size > ws
                ? defVal(f.desc, true)
                : readVal(v, f.desc, off + f.offset, true);
    }
    return out;
}
function readPlain(v, o = v._o, multi = false) {
    _budget = Math.max(v._k().byteLength * 8, 65536);
    _rSeen = new Map();
    try {
        return multi
            ? Array.from({ length: v.length }, (_, i) => readVal(v, v.def, o + i * v.stride, true))
            : readVal(v, v.def, o, true);
    }
    finally {
        _rSeen = null;
    }
}
function setDesc(off, ptr, len, d = sDv) {
    d.setUint32(off, ptr, true);
    d.setUint32(off + 4, len, true);
}
function writeVal(v, desc, val, base, off) {
    if (val === undefined || (val === null && desc.kind !== 'ref' && desc._null === undefined))
        return;
    const top = _wSeen === null && desc.kind !== 'primitive' && desc.kind !== 'str';
    if (top) {
        _wSeen = new Map();
        _wActive = new Set();
        _wFix = [];
        if (v && !('length' in v) && off === v._o && val && typeof val === 'object') {
            _wSeen.set(val, v._o);
        }
    }
    try {
        let d = v ? v._k() : sDv;
        const k = desc.kind;
        if (k === 'primitive') {
            desc._s(d, off, val);
        }
        else if (k === 'str') {
            const s = String(val);
            if (!v) {
                const st = tail;
                ensureScratch(st + s.length * 3 + 8);
                const w = textEncoder.encodeInto(s, sU8.subarray(st)).written;
                tail = st + w;
                setDesc(off, st - base, w);
            }
            else {
                const b = textEncoder.encode(s), st = mutVar(v, off, base, b.byteLength, 1, 1);
                d = v._k();
                u8s(d, st, b.byteLength).set(b);
            }
        }
        else if (k === 'ref') {
            const el = desc.element;
            if (val === null) {
                if (v) {
                    const root = v._a ?? v, oldP = d.getUint32(off, true), oldT = d.getUint32(off + 4, true);
                    if (oldT && base + oldP >= root._o + root.byteLength) {
                        root._dead = (root._dead ?? 0) + el.size;
                    }
                    setDesc(off, 0, 0, d);
                }
            }
            else if (typeof val === 'object' &&
                '_d' in val &&
                val._k().buffer === d.buffer &&
                val._k().byteOffset === d.byteOffset) {
                setDesc(off, val._o - base, 1, d);
            }
            else if (typeof val === 'object' && _wSeen?.has(val)) {
                setDesc(off, _wSeen.get(val) - base, 1, d);
            }
            else {
                let st;
                if (!v) {
                    tail = al(tail, el.align);
                    st = tail;
                    ensureScratch((tail += el.size) + 64);
                    sU8.fill(0, st, tail);
                    initNulls(el, sDv, st);
                    setDesc(off, st - base, 1);
                }
                else {
                    st = mutVar(v, off, base, 1, el.size, el.align);
                    d = v._k();
                    initNulls(el, d, st);
                }
                if (typeof val === 'object')
                    _wSeen?.set(val, st);
                writeVal(v, el, val, base, st);
            }
        }
        else if (k === 'array' || k === 'slice') {
            const el = desc.element, isSav = val instanceof StructArrayView, src = isSav || 'length' in val ? val : Array.from(val), n = k === 'array' ? desc.length : src.length, cp = Math.min(n, src.length) * el.size;
            let st = off;
            if (k === 'slice') {
                if (!v) {
                    if (n)
                        tail = al(tail, el.align);
                    st = tail;
                    ensureScratch((tail += n * el.size) + 64);
                    sU8.fill(0, st, tail);
                    setDesc(off, st - base, n);
                }
                else {
                    st = mutVar(v, off, base, n, el.size, el.align);
                    d = v._k();
                }
            }
            else if (v) {
                u8s(d, st, n * el.size).fill(0);
            }
            const sb = el.kind === 'primitive' && el._C && val instanceof el._C
                ? u8s(val, 0, cp)
                : isSav && el._fv < 0 && val.stride === el.size && val._ws === el.size
                    ? val.bytes.subarray(0, cp)
                    : null;
            if (sb && cp) {
                u8s(d, st, cp).set(sb);
            }
            else {
                const m = Math.min(n, src.length);
                if (el.kind === 'struct' && _wSeen && !isSav) {
                    for (let i = 0; i < m; i++) {
                        const it = src[i];
                        if (it && typeof it === 'object' && !_wSeen.has(it))
                            _wSeen.set(it, st + i * el.size);
                    }
                }
                for (let i = 0; i < m; i++) {
                    const it = isSav ? val.at(i) : src[i], slot = st + i * el.size;
                    if (el.kind === 'struct' && it && typeof it === 'object' && _wActive?.has(it)) {
                        _wFix?.push([slot, _wSeen.get(it), el.size]);
                    }
                    else {
                        writeVal(v, el, it, base, slot);
                    }
                }
            }
            if (el._null !== undefined) {
                for (let i = Math.min(n, src.length); i < n; i++)
                    el._s(d, st + i * el.size, null);
            }
        }
        else {
            const rec = val;
            if (rec && typeof rec === 'object') {
                if (_wActive?.has(rec)) {
                    _wFix?.push([off, _wSeen.get(rec), desc.size]);
                    return;
                }
                if (_wSeen && !_wSeen.has(rec))
                    _wSeen.set(rec, off);
                _wActive?.add(rec);
            }
            if (v && v._ws < desc.size)
                upgradeView(v);
            for (const f of desc.fieldList) {
                if (rec[f.name] !== undefined) {
                    writeVal(v, f.desc, rec[f.name], base, off + f.offset);
                }
                else if (!v && f.desc._null !== undefined) {
                    f.desc._s(d, off + f.offset, null);
                }
                else if (!v && off === base && f.offset === desc._fv) {
                    setDesc(off + f.offset, tail - base, 0);
                }
            }
            if (rec && typeof rec === 'object')
                _wActive?.delete(rec);
        }
    }
    finally {
        if (top) {
            const dEnd = v ? v._k() : sDv;
            for (const [dst, src, sz] of _wFix)
                u8s(dEnd, dst, sz).set(u8s(dEnd, src, sz));
            _wSeen = _wActive = _wFix = null;
        }
    }
}
function initNulls(def, d, o, n = 1, st = def.size) {
    for (const f of def.fieldList)
        if (f.desc._null !== undefined)
            for (let i = 0; i < n; i++)
                f.desc._s(d, o + i * st + f.offset, null);
}
class MemView {
    /** @internal */
    _set(d, b, o, m) {
        this._d = d;
        this._b = b;
        this._o = o;
        this._m = m;
        return this;
    }
    /** @internal */
    _k() {
        const m = this._m;
        if (m !== null) {
            const b = m._buf ? (m.memory ? m.memory.buffer : m._buf) : m.buffer;
            if (b !== this._d.buffer)
                this._d = m.sync ? m.sync()._d : new DataView(b);
        }
        return this._d;
    }
    /** Underlying `ArrayBuffer` (automatically re-bound if backed by a growing `WebAssembly.Memory` or `WasmArena`). */
    get buffer() {
        return this._k().buffer;
    }
    /** Byte offset of this view inside `buffer`. */
    get byteOffset() {
        return this._k().byteOffset + this._o;
    }
    /** Total active + dead bytes occupied by this view's fixed table and tail arena. */
    get usedByteLength() {
        const r = this._a ?? this;
        return r._tl !== undefined ? Math.max(r.byteLength, r._tl - r._o) : r.byteLength;
    }
    /** Dead bytes in the tail arena reclaimable via `.compact()`. */
    get deadByteLength() {
        const r = this._a ?? this;
        return r._dead ?? 0;
    }
    /** Ratio (`0..1`) of dead tail bytes to total used bytes. */
    get compactionRatio() {
        const used = this.usedByteLength;
        return used > 0 ? Math.min(1, this.deadByteLength / used) : 0;
    }
    /** Wire-ready `Uint8Array` view over the underlying bytes (automatically compacts dead tail bytes if dirty). */
    /** Re-packs only live fields and tail data into a tight `Uint8Array` and rebinds this view in-place. */
    compact() {
        const a = this, isArr = 'length' in a, p = pack(this.def, (isArr ? a.toObjects() : [a.toObject()])), o0 = this._o, sz = this.def.size;
        this.byteLength = (isArr ? a.length : 1) * sz;
        this._tl = p.byteLength;
        this._ws = sz;
        this._dead = 0;
        this._dirty = false;
        this._set(new DataView(p.buffer, p.byteOffset, p.byteLength), 0, 0, null);
        if (isArr) {
            a.stride = sz;
            a._cap = a.length;
            for (const pv of [a._c, ...(a._p ?? [])])
                if (pv) {
                    pv._set(this._d, 0, pv._o - o0, a);
                    pv._ws = sz;
                }
        }
        return p;
    }
    /** Wire-ready `Uint8Array` view over the underlying bytes (automatically compacts dead tail bytes if dirty). */
    get bytes() {
        if (this._dirty || this._dead)
            return this.compact();
        const d = this._k();
        return u8s(d, this._o, Math.max(this.byteLength, (this._tl ?? this._o + this.byteLength) - this._o));
    }
}
export class StructViewBase extends MemView {
    /** @internal */
    constructor(descs, dv, base, off, mem = null) {
        super();
        Object.defineProperties(this, descs);
        if (dv)
            this._set(dv, base, off, mem);
    }
    /** Re-positions this flyweight cursor to row `index` (supports negative indices from the end). */
    seek(index) {
        const a = this._a;
        if (a !== undefined)
            return a.at(index, this);
        const st = this._ws || this.def.size, o = this._b + index * st;
        if (o < 0 || o + st > this._k().byteLength)
            oob();
        this._o = o;
        return this;
    }
    set(fieldOrValues, value) {
        if (typeof fieldOrValues === 'string')
            this[fieldOrValues] = value;
        else
            writeVal(this, this.def, fieldOrValues, this._b, this._o);
        return this;
    }
    /** Materializes this binary struct view into a plain JavaScript object. */
    toObject() {
        return readPlain(this);
    }
}
StructViewBase.prototype.at = StructViewBase.prototype.seek;
StructViewBase.prototype.setAll = StructViewBase.prototype.set;
StructViewBase.prototype.toJSON = StructViewBase.prototype.toObject;
function normOpts(b = 0, c, bo, s) {
    if (typeof b === 'number')
        return { o: b, c, b: bo, s };
    return 'kind' in b
        ? { o: 0, s: b.stride }
        : { o: b.byteOffset ?? 0, c: b.count, b: b.baseOffset, s: b.stride };
}
export function structView(def, source, byteOffset = 0, baseOffset, wireStride) {
    const n = normOpts(byteOffset, undefined, baseOffset, wireStride);
    const r = resolveSource(source, n.o), ws = n.s ?? (r.max < def.size ? r.max : def.size);
    if (r.o < 0 || r.max < ws)
        oob();
    const v = new def._V(r.d, n.b ?? r.o, r.o, r.m);
    v._ws = ws;
    v._tl = r.o + Math.max(ws, r.max);
    return v;
}
export class StructArrayView extends MemView {
    constructor(def, source, byteOffset = 0, count, baseOffset, wireStride) {
        super();
        const n = normOpts(byteOffset, count, baseOffset, wireStride);
        const sz = n.s ?? def.size, r = resolveSource(source, n.o);
        const hasVar = def._fv >= 0 && def._fv < sz;
        const f0 = n.c === undefined && r.max >= sz && hasVar ? r.d.getUint32(r.o + def._fv, true) : 0;
        const f1 = n.c === undefined && r.max >= sz && def._fvr ? r.d.getUint32(r.o + def._fv + 4, true) & ~7 : 0;
        const f = f1 || f0;
        const len = n.c ?? (f >= sz && f <= r.max ? f / sz : r.max / sz) | 0;
        const tot = len * sz;
        if (len < 0 || r.o < 0 || r.max < tot)
            oob();
        Object.assign(this, {
            def,
            stride: sz,
            length: len,
            byteLength: tot,
            _ws: sz,
            _tl: r.o + Math.max(tot, r.max),
            _cap: len,
            _dead: 0,
            _dirty: false,
        });
        this._set(r.d, n.b ?? r.o, r.o, r.m);
    }
    /** @internal */
    _mv(index, v) {
        const d = this._k(), o = this._o + index * this.stride, nv = v ? v._set(d, this._b, o, this._m) : new this.def._V(d, this._b, o, this._m);
        nv._ws = this._ws;
        nv._a = this;
        return nv;
    }
    /** Returns a reusable flyweight cursor positioned at `index`. */
    cursor(index = 0) {
        return (this._c = this._mv(index, this._c));
    }
    /** Returns a `StructView<F>` at `index` (supports negative indices from the end, e.g. `rows.at(-1)`). */
    at(index, out) {
        if (index < 0)
            index += this.length;
        if (index < 0 || index >= this.length)
            oob();
        if (out)
            return this._mv(index, out);
        const p = this._p ?? (this._p = []);
        const s = (this._pi = ((this._pi ?? 0) + 1) & 255);
        return (p[s] = this._mv(index, p[s]));
    }
    /** Writes `value` into the struct at `index` (supports negative indices from the end). */
    set(index, value) {
        this.at(index).set(value);
        return this;
    }
    /** Appends one or more rows to the binary array, automatically growing capacity if needed. */
    push(...items) {
        if (this._ws < this.def.size)
            this.compact();
        const def = this.def, st = this.stride, need = this.length + items.length, hasVar = def._fv >= 0;
        if (need > this._cap) {
            const curEnd = this._tl ?? this._o + this.byteLength, tableEnd = this._o + this._cap * st;
            if ((!hasVar || !this.length) && tableEnd === curEnd) {
                allocTail(this, (need - this._cap) * st, def.align);
                this._cap = need;
            }
            else {
                const newCap = Math.max(need, (this._cap || 2) * 2), newO = allocTail(this, al(newCap * st, 8), def.align), d = this._k(), dO = newO - this._o;
                if (this.byteLength > 0) {
                    u8s(d, newO, this.byteLength).set(u8s(d, this._o, this.byteLength));
                    this._dead = (this._dead ?? 0) + this.byteLength;
                }
                this._o = newO;
                this._cap = newCap;
                for (const pv of [this._c, ...(this._p ?? [])])
                    if (pv)
                        pv._o += dO;
            }
        }
        initNulls(def, this._k(), this._o + this.length * st, items.length, st);
        for (const item of items) {
            const idx = this.length++;
            this.byteLength = this.length * st;
            writeVal(this, def, item, this._b, this._o + idx * st);
            if (hasVar)
                this._dirty = true;
        }
        return this.length;
    }
    pop() {
        if (!this.length)
            return undefined;
        const lastIdx = --this.length, val = readPlain(this, this._o + lastIdx * this.stride);
        this.byteLength = this.length * this.stride;
        if (this.def._fv >= 0) {
            this._dirty = true;
            this._dead = (this._dead ?? 0) + this.stride;
        }
        else if (this._tl === this._o + (lastIdx + 1) * this.stride) {
            this._tl -= this.stride;
            this._cap = this.length;
        }
        return val;
    }
    /** Returns a zero-copy `StructArrayView` over `[begin, end)` without copying bytes. */
    subarray(begin = 0, end = this.length) {
        const len = this.length, s = begin < 0 ? Math.max(len + begin, 0) : Math.min(begin, len), e = end < 0 ? Math.max(len + end, 0) : Math.min(end, len), cnt = Math.max(0, e - s), sub = new StructArrayView(this.def, this._k(), this._o + s * this.stride, cnt, this._b, this._ws);
        sub._m = this._m;
        sub._dirty = (this.def._fv >= 0 && (s > 0 || e < len)) || Boolean(this._dirty || this._dead);
        return sub;
    }
    /** Binary search: first row index `i` in `[0..length]` where `row[i][field] >= value` ($O(\log N)$, 0 allocations). */
    lowerBound(field, value) {
        return bsearch(this, field, value, false);
    }
    /** Binary search: first row index `i` in `[0..length]` where `row[i][field] > value` ($O(\log N)$, 0 allocations). */
    upperBound(field, value) {
        return bsearch(this, field, value, true);
    }
    /** Returns a zero-copy `StructArrayView` slice over the sorted range `min <= row[field] <= max` in $O(\log N)$. */
    rangeBy(field, min, max) {
        return this.subarray(this.lowerBound(field, min), this.upperBound(field, max));
    }
    /** Filters rows with a reusable flyweight cursor (0 per-row JS objects) and copies matching binary rows into a `Uint8Array`. */
    filterBytes(predicate) {
        const len = this.length, c = this.cursor(0), def = this.def, st = this.stride;
        if (def._fv >= 0 || st !== def.size || this._ws !== st) {
            const rows = [];
            for (let i = 0; i < len; i++)
                if (predicate(c.seek(i), i))
                    rows.push(c.toObject());
            return pack(def, rows);
        }
        ensureScratch(len * st);
        const src = u8s(this._k(), this._o, len * st);
        let outOff = 0;
        for (let i = 0; i < len; i++) {
            if (predicate(c.seek(i), i)) {
                sU8.set(src.subarray(i * st, (i + 1) * st), outOff);
                outOff += st;
            }
        }
        return sU8.slice(0, outOff);
    }
    /** Extracts a `TypedArray` column for primitive `field` (zero-copy when `stride === field.size`). */
    column(field) {
        const lay = colDesc(this, field), desc = lay.desc, n = this.length, st = this.stride, fo = lay.offset;
        if (fo + desc.size > this._ws)
            return new desc._C(n);
        const d = this._k(), start = d.byteOffset + this._o + fo;
        if (desc.type !== 'bool' && (st === desc.size || n <= 1) && start % desc.align === 0) {
            return new desc._C(d.buffer, start, n);
        }
        const out = new desc._C(n);
        for (let i = 0, off = this._o + fo; i < n; i++, off += st)
            out[i] = desc._g(d, off);
        return out;
    }
    /** Bulk-writes a primitive column from `values` into `field` across all rows. */
    setColumn(field, values) {
        const lay = colDesc(this, field);
        if (lay.offset + lay.size > this._ws)
            this.compact();
        const desc = lay.desc, d = this._k(), st = this.stride, n = Math.min(this.length, values.length);
        for (let i = 0, off = this._o + lay.offset; i < n; i++, off += st) {
            desc._s(d, off, values[i]);
        }
        return this;
    }
    /** Materializes all rows into an array of plain JavaScript objects. */
    toObjects() {
        return readPlain(this, this._o, true);
    }
    [Symbol.iterator]() {
        const c = this.cursor(0);
        const b = this._o;
        const st = this.stride;
        const len = this.length;
        let i = 0;
        const res = { value: c, done: false };
        return {
            next() {
                if (i < len) {
                    c._o = b + i++ * st;
                    return res;
                }
                return { value: undefined, done: true };
            },
        };
    }
}
StructArrayView.prototype.toJSON = StructArrayView.prototype.toObjects;
function colDesc(a, k) {
    const lay = a.def.fields[k];
    if (!lay || lay.desc.kind !== 'primitive' || !lay.desc._C) {
        throw new TypeError(`Field "${String(k)}" is not a primitive column`);
    }
    return lay;
}
function bsearch(a, k, v, eq) {
    const lay = colDesc(a, k), g = lay.desc._g, d = a._k(), b = a._o + lay.offset, st = a.stride;
    let lo = 0, hi = a.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1, x = g(d, b + mid * st);
        if (eq ? x <= v : x < v)
            lo = mid + 1;
        else
            hi = mid;
    }
    return lo;
}
export class WasmArena {
    constructor(backing = 65536, baseOffset = 0) {
        this.memory = isWasmMemory(backing) ? backing : null;
        this.baseOffset = this.offset = baseOffset;
        this._rebind(this.memory
            ? this.memory.buffer
            : backing instanceof ArrayBuffer
                ? backing
                : new ArrayBuffer(Math.max(backing, baseOffset)));
    }
    /** @internal */
    _rebind(buf) {
        this._buf = buf;
        this._d = new DataView(buf);
        this._u8 = new Uint8Array(buf);
        return this;
    }
    sync() {
        if (this.memory !== null && this.memory.buffer !== this._buf) {
            this._rebind(this.memory.buffer);
        }
        return this;
    }
    get buffer() {
        return this.sync()._buf;
    }
    get byteLength() {
        return this.sync()._buf.byteLength;
    }
    get bytesUsed() {
        return this.offset - this.baseOffset;
    }
    get u8() {
        return this.sync()._u8;
    }
    get dataView() {
        return this.sync()._d;
    }
    alignTo(align) {
        if (align > 1) {
            this.offset = (this.offset + align - 1) & ~(align - 1);
        }
        return this.offset;
    }
    ensureCapacity(requiredByteLength) {
        this.sync();
        if (requiredByteLength <= this._buf.byteLength)
            return this;
        if (this.memory !== null) {
            this.memory.grow(Math.ceil((requiredByteLength - this._buf.byteLength) / 65536));
            return this._rebind(this.memory.buffer);
        }
        const nb = new ArrayBuffer(Math.max(requiredByteLength, this._buf.byteLength * 2, 64));
        new Uint8Array(nb).set(this._u8);
        return this._rebind(nb);
    }
    /** @internal */
    _alloc(bytes, align, zero = false) {
        const p = this.alignTo(align), end = (this.offset = p + bytes);
        this.ensureCapacity(end);
        if (zero && bytes > 0)
            this._u8.fill(0, p, end);
        return p;
    }
    alloc(def, count = 1, zero = false) {
        const p = this._alloc(count * def.size, def.align, zero);
        initNulls(def, this._d, p, count);
        return new StructArrayView(def, this, p, count);
    }
    allocOne(def, init) {
        const p = this._alloc(def.size, def.align, true), v = new def._V(this._d, p, p, this);
        initNulls(def, this._d, p);
        return init !== undefined ? v.setAll(init) : v;
    }
    placeBytes(bytes, alignOrDef = 8) {
        const u = bytes instanceof Uint8Array ? bytes : u8s(bytes), p = this._alloc(u.byteLength, typeof alignOrDef === 'number' ? alignOrDef : alignOrDef.align);
        this._u8.set(u, p);
        const sub = new Uint8Array(this._buf, p, u.byteLength);
        Object.defineProperties(sub, {
            ptr: hid(p),
            as: hid((def, c = Math.floor(u.byteLength / def.size)) => new StructArrayView(def, this, p, c)),
        });
        return sub;
    }
    view(def, byteOffset, baseOffset = byteOffset) {
        return structView(def, this.sync(), byteOffset, baseOffset);
    }
    viewArray(def, byteOffset, count) {
        return new StructArrayView(def, this.sync(), byteOffset, count);
    }
    reset(baseOffset = this.baseOffset) {
        this.offset = baseOffset;
        return this;
    }
}
export const Arena = WasmArena;
export class StructDef {
    constructor(name, schemaOrBuilder) {
        const schema = typeof schemaOrBuilder === 'function' ? schemaOrBuilder((() => this)) : schemaOrBuilder;
        if (!schema)
            throw new TypeError('Struct schema fields are required');
        let off = 0;
        let maxA = 1;
        let firstV = -1, fvr = false;
        const fObj = {};
        const descs = { ...BASE_DESCS };
        for (const [k, d] of Object.entries(schema)) {
            const a = d.align;
            maxA = Math.max(maxA, a);
            const fo = (off = al(off, a));
            fObj[k] = {
                name: k,
                desc: d,
                offset: fo,
                size: d.size,
                align: a,
            };
            off += d.size;
            const dk = d.kind;
            if ((dk === 'str' || dk === 'slice' || dk === 'ref' || (dk === 'struct' && d._fv >= 0)) && firstV < 0) {
                firstV = dk === 'struct' ? fo + d._fv : fo;
                fvr = dk === 'ref';
            }
            const end = fo + d.size;
            descs[k] = {
                enumerable: true,
                configurable: true,
                get() {
                    if (end > this._ws)
                        return defVal(d, false);
                    if (dk === 'primitive') {
                        try {
                            return d._g(this._m?._d ?? this._d, this._o + fo);
                        }
                        catch {
                            return d._g(this._k(), this._o + fo);
                        }
                    }
                    return readVal(this, d, this._o + fo, false);
                },
                set(v) {
                    if (end > this._ws)
                        upgradeView(this);
                    writeVal(this, d, v, this._b, this._o + fo);
                },
            };
        }
        const sz = al(off, maxA);
        descs._ws = hid(sz);
        class SpecializedStructView extends StructViewBase {
            constructor(dv, b, o, m) {
                super(descs, dv, b, o, m);
            }
        }
        SpecializedStructView.prototype.def = this;
        SpecializedStructView.prototype.byteLength = sz;
        Object.assign(this, {
            kind: 'struct',
            name,
            rustType: name || 'AnonStruct',
            schema,
            size: sz,
            stride: sz,
            align: maxA,
            fields: fObj,
            fieldList: Object.values(fObj),
            _fv: firstV,
            _fvr: fvr,
            _V: SpecializedStructView,
        });
    }
    offsetOf(field) {
        return this.fields[field].offset;
    }
    /** Allocates a single `StructView<F>` backed by a fresh buffer and optionally initializes fields. */
    create(init) {
        const v = this.view(new ArrayBuffer(this.size));
        initNulls(this, v._d, 0);
        return init !== undefined ? v.setAll(init) : v;
    }
    /** Infers `Partial<StructInput<F>>` on a plain JS object literal (for building typed cyclic JS graphs without `: any`). */
    item(init) {
        return init;
    }
    /** Wraps a binary buffer (`Uint8Array`, `ArrayBuffer`, `DataView`, `WebAssembly.Memory`, `WasmArena`) in a zero-copy `StructView<F>`. */
    view(source, byteOffset, baseOffset, wireStride) {
        return structView(this, source, byteOffset, baseOffset, wireStride);
    }
    /** Wraps a binary buffer in a zero-copy `StructArrayView<F>`. */
    array(source, byteOffset, count, baseOffset, wireStride) {
        return new StructArrayView(this, source, byteOffset, count, baseOffset, wireStride);
    }
    /** Allocates a growable `StructArrayView<F>` for `count` rows (pass `0` for an empty growable array). */
    alloc(count) {
        const a = this.array(new ArrayBuffer(count * this.size), 0, count);
        initNulls(this, a._d, 0, count);
        return a;
    }
    /** Packs an array of plain JavaScript objects into an 8-byte-aligned `Uint8Array`. */
    pack(rows) {
        return pack(this, rows);
    }
    /** Concatenates multiple `StructArrayView<F>` or `Uint8Array` chunks into a single packed `Uint8Array` via bulk `memcpy` when fixed-size. */
    concatBytes(chunks) {
        return concatBytes(this, chunks);
    }
}
/** Concatenates multiple `StructArrayView<F>` or `Uint8Array` chunks into a single packed `Uint8Array` via bulk `memcpy` when fixed-size. */
export function concatBytes(def, chunks) {
    if (def._fv >= 0) {
        return pack(def, chunks.flatMap((c) => (c instanceof Uint8Array ? def.array(c) : c).toObjects()));
    }
    const slices = chunks.map((c) => c instanceof Uint8Array ? (c.byteLength % def.size && oob(), c) : c.stride === def.size ? c.bytes : c.compact());
    const out = new Uint8Array(slices.reduce((s, b) => s + b.byteLength, 0));
    let off = 0;
    for (const s of slices) {
        out.set(s, off);
        off += s.byteLength;
    }
    return out;
}
/** Packs an array of plain JavaScript objects into an 8-byte-aligned `Uint8Array`. */
export function pack(def, rows) {
    const n = rows.length;
    const st = def.size;
    const tb = n * st;
    const ts = def._fv >= 0 ? al(tb + 1, 8) : tb;
    ensureScratch(ts + n * 64 + 64);
    sU8.fill(0, 0, ts);
    initNulls(def, sDv, 0, n, st);
    tail = ts;
    _wSeen = new Map();
    _wActive = new Set();
    _wFix = [];
    for (let i = 0; i < n; i++) {
        const r = rows[i];
        if (r && typeof r === 'object')
            _wSeen.set(r, i * st);
    }
    try {
        for (let i = 0; i < n; i++) {
            writeVal(null, def, rows[i], 0, i * st);
        }
        for (const [dst, src, sz] of _wFix)
            u8s(sDv, dst, sz).set(u8s(sDv, src, sz));
    }
    finally {
        _wSeen = _wActive = _wFix = null;
    }
    if (n && def._fv >= 0 && sDv.getUint32(def._fv, true) < ts) {
        if (sDv.getUint32(def._fv + 4, true))
            sDv.setUint32(def._fv + 4, ts | 1, true);
        else
            sDv.setUint32(def._fv, ts, true);
    }
    const end = al(tail, 8);
    sU8.fill(0, tail, end);
    return sU8.slice(0, end);
}
export function defineStruct(nameOrFields, maybeFields) {
    return typeof nameOrFields === 'string'
        ? new StructDef(nameOrFields, maybeFields)
        : new StructDef('', nameOrFields);
}
/** Alias for `defineStruct`. */
export const struct = defineStruct;
