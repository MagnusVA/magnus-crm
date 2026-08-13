/**
 * The project compiles with TypeScript 7 (native, tsgo), whose JS compiler
 * API is unavailable until TS 7.1. typescript-eslint still needs the JS API,
 * so pin the ESLint toolchain to a JS-based TypeScript 5.9 instance by
 * converting its `typescript` peer dependency into a regular dependency.
 * Remove this once typescript-eslint supports TypeScript 7.
 */
const TS5_CONSUMERS = new Set([
	"@typescript-eslint/parser",
	"@typescript-eslint/typescript-estree",
	"@typescript-eslint/tsconfig-utils",
	"@typescript-eslint/project-service",
	"@typescript-eslint/type-utils",
	"@typescript-eslint/utils",
	"@typescript-eslint/eslint-plugin",
	"typescript-eslint",
	"ts-api-utils",
]);

function readPackage(pkg) {
	if (TS5_CONSUMERS.has(pkg.name)) {
		if (pkg.peerDependencies) {
			delete pkg.peerDependencies.typescript;
		}
		pkg.dependencies = { ...pkg.dependencies, typescript: "5.9.3" };
	}
	return pkg;
}

module.exports = { hooks: { readPackage } };
