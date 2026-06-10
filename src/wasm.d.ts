// `.wasm` imports are bundled as compiled `WebAssembly.Module` instances via the
// `CompiledWasm` rule in wrangler.jsonc. Declared here (not in the generated
// worker-configuration.d.ts) so `import wasmModule from '...wasm'` typechecks.
declare module '*.wasm' {
	const mod: WebAssembly.Module;
	export default mod;
}
