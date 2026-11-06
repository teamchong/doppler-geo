function isStructDef(v) {
    return typeof v === 'object' && v !== null && 'kind' in v && v.kind === 'struct';
}
function collectDefs(input) {
    const roots = isStructDef(input)
        ? [input]
        : Array.isArray(input)
            ? input
            : Object.values(input).filter(isStructDef);
    const visited = new Set();
    const ordered = [];
    function visitDesc(desc) {
        if (desc.kind === 'struct') {
            visitStruct(desc);
        }
        else if (desc.kind === 'array' || desc.kind === 'slice') {
            visitDesc(desc.element);
        }
    }
    function visitStruct(def, fallbackName) {
        const name = def.name || fallbackName || 'AnonStruct';
        if (visited.has(name))
            return;
        visited.add(name);
        for (const f of def.fieldList) {
            visitDesc(f.desc);
        }
        ordered.push({ def, name });
    }
    if (!isStructDef(input) && !Array.isArray(input)) {
        for (const [k, v] of Object.entries(input)) {
            if (isStructDef(v))
                visitStruct(v, k);
        }
    }
    else {
        for (const r of roots)
            visitStruct(r);
    }
    return ordered.map(({ def, name }) => (def.name ? def : { ...def, name }));
}
function checkVarTypes(desc, flags) {
    if (desc.kind === 'str')
        flags.str = true;
    else if (desc.kind === 'slice') {
        flags.slice = true;
        checkVarTypes(desc.element, flags);
    }
    else if (desc.kind === 'array') {
        checkVarTypes(desc.element, flags);
    }
}
export function toRustReprC(schemas, options = {}) {
    const defs = collectDefs(schemas);
    const derives = options.derive ?? ['Copy', 'Clone'];
    const emitAsserts = options.assertions ?? true;
    const vis = options.vis === undefined ? 'pub ' : options.vis ? `${options.vis} ` : '';
    const flags = { str: false, slice: false };
    for (const d of defs) {
        for (const f of d.fieldList) {
            checkVarTypes(f.desc, flags);
        }
    }
    const deriveAttr = derives.length > 0 ? `#[derive(${derives.join(', ')})]\n` : '';
    const blocks = [];
    if (flags.str) {
        blocks.push(`#[repr(C)]\n${deriveAttr}${vis}struct CapnStr {\n    ${vis}off: u32,\n    ${vis}len: u32,\n}\n\nimpl CapnStr {\n    #[inline]\n    ${vis}fn as_bytes<'a>(&self, base: &'a [u8]) -> &'a [u8] {\n        let start = self.off as usize;\n        let end = start + (self.len as usize);\n        &base[start..end]\n    }\n\n    #[inline]\n    ${vis}fn as_str<'a>(&self, base: &'a [u8]) -> Result<&'a str, core::str::Utf8Error> {\n        core::str::from_utf8(self.as_bytes(base))\n    }\n}`);
    }
    if (flags.slice) {
        blocks.push(`#[repr(C)]\n${deriveAttr}${vis}struct CapnSlice<T> {\n    ${vis}off: u32,\n    ${vis}len: u32,\n    ${vis}_marker: core::marker::PhantomData<T>,\n}\n\nimpl<T> CapnSlice<T> {\n    #[inline]\n    ${vis}unsafe fn as_slice<'a>(&self, base: &'a [u8]) -> &'a [T] {\n        if self.len == 0 {\n            return &[];\n        }\n        unsafe {\n            core::slice::from_raw_parts(\n                base.as_ptr().add(self.off as usize) as *const T,\n                self.len as usize,\n            )\n        }\n    }\n}`);
    }
    for (const def of defs) {
        const name = def.name || 'AnonStruct';
        const lines = [`#[repr(C)]`, `${deriveAttr}${vis}struct ${name} {`];
        for (const f of def.fieldList) {
            lines.push(`    ${vis}${f.name}: ${f.desc.rustType},`);
        }
        lines.push(`}`);
        if (emitAsserts) {
            lines.push(`const _: () = {`);
            lines.push(`    assert!(core::mem::size_of::<${name}>() == ${def.size});`);
            lines.push(`    assert!(core::mem::align_of::<${name}>() == ${def.align});`);
            for (const f of def.fieldList) {
                lines.push(`    assert!(core::mem::offset_of!(${name}, ${f.name}) == ${f.offset});`);
            }
            lines.push(`};`);
        }
        blocks.push(lines.join('\n'));
    }
    return blocks.join('\n\n') + '\n';
}
export const generateRust = toRustReprC;
