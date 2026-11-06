import { generateRust, toRustReprC, } from './codegen.js';
export { generateRust, toRustReprC };
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const oob = () => {
    throw new RangeError('Out of bounds');
};
const al = (x, a) => (x + a - 1) & ~(a - 1);
function hid(value) {
    return { value, writable: true, enumerable: false, configurable: true };
}
const BASE_DESCS = Object.fromEntries(['_d', '_o', '_b', '_m', '_a', '_ws', '_tl', '_dead', '_dirty'].map((k) => [k, hid()]));
function prim(type, _C, _g, _s) {
    const c = type[0];
    const size = (+type.slice(1) || 8) >> 3;
    const float = c === 'f';
    return {
        kind: 'primitive',
        type,
        rustType: type,
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
export const u8 = prim('u8', Uint8Array, (d, o) => d.getUint8(o), (d, o, v) => d.setUint8(o, +Number(v)));
/** Signed 8-bit integer (`-128..127`, 1 byte, 1-byte aligned). */
export const i8 = prim('i8', Int8Array, (d, o) => d.getInt8(o), (d, o, v) => d.setInt8(o, +Number(v)));
/** Little-endian unsigned 16-bit integer (`0..65535`, 2 bytes, 2-byte aligned). */
export const u16 = prim('u16', Uint16Array, (d, o) => d.getUint16(o, true), (d, o, v) => d.setUint16(o, +Number(v), true));
/** Little-endian signed 16-bit integer (`-32768..32767`, 2 bytes, 2-byte aligned). */
export const i16 = prim('i16', Int16Array, (d, o) => d.getInt16(o, true), (d, o, v) => d.setInt16(o, +Number(v), true));
/** Little-endian unsigned 32-bit integer (4 bytes, 4-byte aligned). */
export const u32 = prim('u32', Uint32Array, (d, o) => d.getUint32(o, true), (d, o, v) => d.setUint32(o, +Number(v), true));
/** Little-endian signed 32-bit integer (4 bytes, 4-byte aligned). */
export const i32 = prim('i32', Int32Array, (d, o) => d.getInt32(o, true), (d, o, v) => d.setInt32(o, +Number(v), true));
/** Little-endian unsigned 64-bit integer (`bigint`, 8 bytes, 8-byte aligned). */
export const u64 = prim('u64', BigUint64Array, (d, o) => d.getBigUint64(o, true), (d, o, v) => d.setBigUint64(o, BigInt(v), true));
/** Little-endian signed 64-bit integer (`bigint`, 8 bytes, 8-byte aligned). */
export const i64 = prim('i64', BigInt64Array, (d, o) => d.getBigInt64(o, true), (d, o, v) => d.setBigInt64(o, BigInt(v), true));
/** IEEE 754 32-bit float (4 bytes, 4-byte aligned). */
export const f32 = prim('f32', Float32Array, (d, o) => d.getFloat32(o, true), (d, o, v) => d.setFloat32(o, +Number(v), true));
/** IEEE 754 64-bit float (8 bytes, 8-byte aligned). */
export const f64 = prim('f64', Float64Array, (d, o) => d.getFloat64(o, true), (d, o, v) => d.setFloat64(o, +Number(v), true));
/** 1-byte boolean (`0` or `1`, 1-byte aligned). */
export const bool = prim('bool', Uint8Array, (d, o) => d.getUint8(o) !== 0, (d, o, v) => d.setUint8(o, v ? 1 : 0));
/** Variable-length UTF-8 string stored in the tail arena via an 8-byte `[u32 off, u32 len]` descriptor. */
export const str = {
    kind: 'str',
    size: 8,
    align: 4,
    rustType: 'CapnStr',
};
/** Fixed-length inline array `[T; N]` stored directly inside the struct body. */
export function fixedArray(element, length) {
    if (!Number.isInteger(length) || length < 0) {
        oob();
    }
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
/** Variable-length slice `CapnSlice<T>` stored in the tail arena via an 8-byte `[u32 off, u32 len]` descriptor. */
export function slice(element) {
    return {
        kind: 'slice',
        element,
        size: 8,
        align: 4,
        rustType: `CapnSlice<${element.rustType}>`,
    };
}
/** Alias for `slice(element)`. */
export const list = slice;
let sBuf = new ArrayBuffer(65536);
let sDv = new DataView(sBuf);
let sU8 = new Uint8Array(sBuf);
let tail = 0;
function ensureScratch(minBytes) {
    if (minBytes > sBuf.byteLength) {
        const nb = new ArrayBuffer(Math.max(minBytes, sBuf.byteLength * 2));
        sDv = new DataView((sBuf = nb));
        const nu = new Uint8Array(nb);
        nu.set(sU8);
        sU8 = nu;
    }
}
export function isWasmMemory(x) {
    return typeof WebAssembly !== 'undefined' && x instanceof WebAssembly.Memory;
}
function isMemOrArena(x) {
    return (typeof x === 'object' && x !== null && '_u8' in x) || isWasmMemory(x);
}
function resolveSource(s, byteOffset = 0) {
    const v = ArrayBuffer.isView(s);
    const m = isMemOrArena(s) ? s : null;
    const b = v ? s.buffer : m ? m.buffer : s;
    return {
        d: new DataView(b),
        o: (v ? s.byteOffset : 0) + byteOffset,
        max: (v ? s.byteLength : b.byteLength) - byteOffset,
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
            new Uint8Array(nb).set(new Uint8Array(d.buffer, d.byteOffset, cur));
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
        new Uint8Array(d.buffer, d.byteOffset + p, bytes).fill(0);
    }
    root._tl = end;
    return p;
}
function mutVar(v, off, base, count, elSize, align) {
    const root = v._a ?? v;
    let d = v._k();
    const oldP = d.getUint32(off, true), oldB = d.getUint32(off + 4, true) * elSize, bytes = count * elSize;
    let st = base + oldP;
    if (bytes <= oldB) {
        if (oldB > bytes)
            root._dead = (root._dead ?? 0) + (oldB - bytes);
    }
    else {
        if (oldB)
            root._dead = (root._dead ?? 0) + oldB;
        st = allocTail(root, bytes, align);
        d = (v._d = root._d);
        if (root.def && off === root._b + root.def._fv)
            root._dirty = true;
    }
    if (bytes)
        new Uint8Array(d.buffer, d.byteOffset + st, bytes).fill(0);
    setDesc(off, count ? st - base : 0, count, d);
    return st;
}
function upgradeView(v) {
    if (v._ws >= v.def.size)
        return;
    if (v._a) {
        v._a.compact();
        return;
    }
    const p = allocTail(v, v.def.size, v.def.align), d = v._k();
    new Uint8Array(d.buffer, d.byteOffset + p, v._ws).set(new Uint8Array(d.buffer, d.byteOffset + v._o, v._ws));
    v._o = p;
    v._ws = v.byteLength = v.def.size;
}
function readVal(v, desc, off, plain, len) {
    const d = v._k();
    const k = desc.kind;
    if (len !== undefined) {
        const sz = desc.size;
        const tot = d.byteOffset + off;
        if (!plain && k === 'primitive' && desc.type !== 'bool' && tot % sz === 0) {
            return new desc._C(d.buffer, tot, len);
        }
        if (!plain && k === 'struct') {
            const sav = new StructArrayView(desc, d.buffer, tot, len, v._b);
            sav._m = v._m;
            sav._a = v._a ?? v;
            return sav;
        }
        return Array.from({ length: len }, (_, i) => readVal(v, desc, off + i * sz, plain));
    }
    if (k === 'primitive')
        return desc._g(d, off);
    if (k === 'str') {
        const l = d.getUint32(off + 4, true);
        if (!l)
            return '';
        const p = v._b + d.getUint32(off, true);
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
        return (s || textDecoder.decode(new Uint8Array(d.buffer, d.byteOffset + p, l)));
    }
    if (k === 'array' || k === 'slice') {
        const n = k === 'array' ? desc.length : d.getUint32(off + 4, true);
        return readVal(v, desc.element, k === 'array' ? off : n ? v._b + d.getUint32(off, true) : 0, plain, n);
    }
    if (!plain) {
        const nv = new desc._V(d, v._b, off, v._m);
        nv._a = v._a ?? v;
        return nv;
    }
    const out = {};
    const ws = v._ws ?? desc.size;
    for (const f of desc.fieldList) {
        out[f.name] =
            f.offset + f.size > ws
                ? defVal(f.desc, true)
                : readVal(v, f.desc, off + f.offset, true);
    }
    return out;
}
function setDesc(off, ptr, len, d = sDv) {
    d.setUint32(off, ptr, true);
    d.setUint32(off + 4, len, true);
}
function writeVal(v, desc, val, base, off) {
    if (val === undefined || val === null)
        return;
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
            const b = textEncoder.encode(s), st = mutVar(v, off, base, b.byteLength, 1, 1), d = v._k();
            new Uint8Array(d.buffer, d.byteOffset + st, b.byteLength).set(b);
        }
    }
    else if (k === 'array' || k === 'slice') {
        const arr = Array.from(val);
        const el = desc.element;
        if (k === 'array') {
            for (let i = 0; i < desc.length; i++) {
                writeVal(v, el, i < arr.length ? arr[i] : 0, base, off + i * el.size);
            }
        }
        else {
            const n = arr.length;
            let st = 0;
            if (!v) {
                if (n)
                    tail = al(tail, el.align);
                st = tail;
                ensureScratch((tail += n * el.size) + 64);
                sU8.fill(0, st, tail);
                setDesc(off, st - base, n);
            }
            else
                st = mutVar(v, off, base, n, el.size, el.align);
            for (let i = 0; i < n; i++)
                writeVal(v, el, arr[i], base, st + i * el.size);
        }
    }
    else {
        const rec = val;
        if (v && v._ws < desc.size)
            upgradeView(v);
        for (const f of desc.fieldList) {
            if (rec[f.name] !== undefined) {
                writeVal(v, f.desc, rec[f.name], base, off + f.offset);
            }
        }
    }
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
        return this._o;
    }
    /** Wire-ready `Uint8Array` view over the underlying bytes (automatically compacts dead tail bytes if dirty). */
    get bytes() {
        if (this._dirty && 'compact' in this) {
            return this.compact();
        }
        const d = this._k(), end = this._tl !== undefined ? this._tl - this._o : this.byteLength;
        return new Uint8Array(d.buffer, d.byteOffset + this._o, Math.max(this.byteLength, end));
    }
}
export class StructViewBase extends MemView {
    /** @internal */
    constructor(descs, dv, base, off, mem) {
        super();
        if (!dv) {
            const s = this;
            s._0 = s._1 = s._2 = s._3 = s._4 = s._5 = s._6 = s._7 = s._8 = s._9 = s._a = s._b = s._c = s._d = s._e = s._f = s._g = s._h = s._i = s._j = s._k = s._l = s._m = s._n = 0;
        }
        Object.defineProperties(this, descs);
        this._set(dv, base, off, mem);
    }
    set(fieldOrValues, value) {
        if (typeof fieldOrValues === 'string') {
            writeVal(this, this.def.fields[fieldOrValues].desc, value, this._b, this._o + this.def.fields[fieldOrValues].offset);
        }
        else {
            writeVal(this, this.def, fieldOrValues, this._b, this._o);
        }
        return this;
    }
    /** Materializes this binary struct view into a plain JavaScript object. */
    toObject() {
        return readVal(this, this.def, this._o, true);
    }
}
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
        const f = n.c === undefined && r.max >= 8 && hasVar ? r.d.getUint32(r.o + def._fv, true) : 0;
        const len = n.c ?? (((f >= sz && f <= r.max ? f : r.max) / sz) | 0);
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
        const d = this._k(), o = this._o + index * this.stride;
        if (v) {
            v._ws = this._ws;
            v._a = this;
            return v._set(d, this._b, o, this._m);
        }
        const nv = new this.def._V(d, this._b, o, this._m);
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
        if (index < 0)
            index += this.length;
        if (index < 0 || index >= this.length)
            oob();
        if (this._ws < this.def.size)
            this.compact();
        writeVal(this, this.def, value, this._b, this._o + index * this.stride);
        return this;
    }
    /** Appends one or more rows to the binary array, automatically growing capacity if needed. */
    push(...items) {
        if (this._ws < this.def.size)
            this.compact();
        const def = this.def, st = this.stride, need = this.length + items.length, hasVar = def._fv >= 0;
        if (need > this._cap) {
            const curEnd = this._tl ?? this._o + this.byteLength, tableEnd = this._o + this._cap * st;
            if (!hasVar && tableEnd === curEnd) {
                allocTail(this, (need - this._cap) * st, def.align);
                this._cap = need;
            }
            else {
                const newCap = Math.max(need, (this._cap || 2) * 2);
                if (this.length === 0 && this._o === curEnd) {
                    allocTail(this, al(newCap * st, 8), def.align);
                    this._cap = newCap;
                }
                else {
                    const newO = allocTail(this, al(newCap * st, 8), def.align), d = this._k(), dO = newO - this._o;
                    if (this.byteLength > 0) {
                        new Uint8Array(d.buffer, d.byteOffset + newO, this.byteLength).set(new Uint8Array(d.buffer, d.byteOffset + this._o, this.byteLength));
                        this._dead = (this._dead ?? 0) + this.byteLength;
                    }
                    this._o = newO;
                    this._cap = newCap;
                    for (const pv of [this._c, ...(this._p ?? [])])
                        if (pv)
                            pv._o += dO;
                }
            }
        }
        for (const item of items) {
            const idx = this.length++;
            this.byteLength = this.length * st;
            writeVal(this, def, item && typeof item === 'object' && 'toObject' in item ? item.toObject() : item, this._b, this._o + idx * st);
        }
        if (hasVar)
            this._dirty = true;
        return this.length;
    }
    /** Removes and returns the last row as a plain JS object (or `undefined` if empty). */
    pop() {
        if (!this.length)
            return undefined;
        const lastIdx = --this.length, val = readVal(this, this.def, this._o + lastIdx * this.stride, true);
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
    /** Ratio (`0..1`) of dead tail bytes to total used bytes. */
    get compactionRatio() {
        const used = (this._tl ?? this.byteLength) - this._b;
        return used > 0 ? Math.min(1, (this._dead ?? 0) / used) : 0;
    }
    /** Re-packs only live rows and tail data into a tight `Uint8Array` and rebinds this view in-place. */
    compact() {
        const packed = pack(this.def, this.toObjects()), d = new DataView(packed.buffer, packed.byteOffset, packed.byteLength), oldO = this._o, sz = this.def.size;
        Object.assign(this, {
            stride: sz,
            byteLength: this.length * sz,
            _ws: sz,
            _tl: packed.byteLength,
            _cap: this.length,
            _dead: 0,
            _dirty: false,
        });
        this._set(d, 0, 0, null);
        for (const pv of [this._c, ...(this._p ?? [])])
            if (pv) {
                pv._set(d, 0, pv._o - oldO, this);
                pv._ws = sz;
            }
        return packed;
    }
    /** Extracts a `TypedArray` column for primitive `field` (zero-copy when `stride === field.size`). */
    column(field) {
        const lay = this.def.fields[field];
        if (!lay || lay.desc.kind !== 'primitive')
            throw new TypeError(`Field "${String(field)}" is not a primitive column`);
        const desc = lay.desc, n = this.length, st = this.stride, fo = lay.offset;
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
        const lay = this.def.fields[field];
        if (!lay || lay.desc.kind !== 'primitive')
            throw new TypeError(`Field "${String(field)}" is not a primitive column`);
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
        return Array.from(this, (c) => c.toObject());
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
        return new StructArrayView(def, this, this._alloc(count * def.size, def.align, zero), count);
    }
    allocOne(def, init) {
        const p = this._alloc(def.size, def.align, true), v = new def._V(this._d, p, p, this);
        return init !== undefined ? v.setAll(init) : v;
    }
    placeBytes(bytes, alignOrDef = 8) {
        const u = bytes instanceof Uint8Array
            ? bytes
            : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), p = this._alloc(u.byteLength, typeof alignOrDef === 'number' ? alignOrDef : alignOrDef.align);
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
    constructor(name, schema) {
        if (!schema)
            throw new TypeError('Struct schema fields are required');
        let off = 0;
        let maxA = 1;
        let firstV = -1;
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
            if ((dk === 'str' || dk === 'slice' || (dk === 'struct' && d._fv >= 0)) && firstV < 0) {
                firstV = dk === 'struct' ? fo + d._fv : fo;
            }
            const end = fo + d.size;
            descs[k] = {
                enumerable: true,
                configurable: true,
                get() {
                    if (end > this._ws)
                        return defVal(d, false);
                    if (dk === 'primitive') {
                        const m = this._m;
                        if (m && m._d && m._d !== this._d)
                            this._d = m._d;
                        try {
                            return d._g(this._d, this._o + fo);
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
        Object.assign(SpecializedStructView.prototype, {
            def: this,
            byteLength: sz,
            _ws: sz,
        });
        for (let i = 0; i < 8; i++) {
            new SpecializedStructView(1, 0, 0, null);
        }
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
            _V: SpecializedStructView,
        });
    }
    /** Returns the byte offset of `field` within the struct. */
    offsetOf(field) {
        return this.fields[field].offset;
    }
    /** Allocates a single `StructView<F>` backed by a fresh buffer and optionally initializes fields. */
    create(init) {
        const v = this.view(new ArrayBuffer(this.size));
        return init !== undefined ? v.setAll(init) : v;
    }
    /** Wraps a binary buffer (`Uint8Array`, `ArrayBuffer`, `DataView`, `WebAssembly.Memory`, `WasmArena`) in a zero-copy `StructView<F>`. */
    view(source, byteOffset = 0, baseOffset, wireStride) {
        return structView(this, source, byteOffset, baseOffset, wireStride);
    }
    /** Wraps a binary buffer in a zero-copy `StructArrayView<F>`. */
    array(source, byteOffset = 0, count, wireStride) {
        return new StructArrayView(this, source, byteOffset, count, undefined, wireStride);
    }
    /** Allocates a growable `StructArrayView<F>` for `count` rows (pass `0` for an empty growable array). */
    alloc(count) {
        return this.array(new ArrayBuffer(count * this.size), 0, count);
    }
    /** Packs an array of plain JavaScript objects into an 8-byte-aligned `Uint8Array`. */
    pack(rows) {
        return pack(this, rows);
    }
}
/** Packs an array of plain JavaScript objects into an 8-byte-aligned `Uint8Array`. */
export function pack(def, rows) {
    const n = rows.length;
    const st = def.size;
    const tb = n * st;
    const ts = def._fv >= 0 ? al(tb + 1, 8) : tb;
    ensureScratch(ts + n * 64 + 64);
    sU8.fill(0, 0, ts);
    tail = ts;
    for (let i = 0; i < n; i++) {
        writeVal(null, def, rows[i], 0, i * st);
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
//# sourceMappingURL=index.js.map