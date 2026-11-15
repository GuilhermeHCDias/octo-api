// Vite's `?raw` suffix: the file's text as the default export.
declare module "*?raw" {
	const text: string;
	export default text;
}
