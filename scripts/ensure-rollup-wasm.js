const fs = require('fs');
const path = require('path');

const nativeJsPath = path.resolve(__dirname, '../node_modules/rollup/dist/native.js');

if (fs.existsSync(nativeJsPath)) {
  let content = fs.readFileSync(nativeJsPath, 'utf8');
  if (!content.includes('@rollup/wasm-node/dist/native.js')) {
    // Replace the throw error on ERR_DLOPEN_FAILED with a fallback to @rollup/wasm-node
    const pattern = /if\s*\(\s*error\s+instanceof\s+Error\s+&&\s+error\.code\s*===\s*'ERR_DLOPEN_FAILED'\s*\)\s*\{\s*throw\s+error;\s*\}/;
    const replacement = `if (error instanceof Error && error.code === 'ERR_DLOPEN_FAILED') {\n\t\t\ttry {\n\t\t\t\treturn require('@rollup/wasm-node/dist/native.js');\n\t\t\t} catch {\n\t\t\t\tthrow error;\n\t\t\t}\n\t\t}`;
    
    if (pattern.test(content)) {
      content = content.replace(pattern, replacement);
      fs.writeFileSync(nativeJsPath, content, 'utf8');
      console.log('[ensure-rollup-wasm] Successfully patched Rollup with @rollup/wasm-node fallback.');
    } else {
      console.log('[ensure-rollup-wasm] Pattern not matched, checking direct replacement...');
      const target = "if (error instanceof Error && error.code === 'ERR_DLOPEN_FAILED') {\n\t\t\tthrow error;\n\t\t}";
      if (content.includes(target)) {
        content = content.replace(target, replacement);
        fs.writeFileSync(nativeJsPath, content, 'utf8');
        console.log('[ensure-rollup-wasm] Successfully patched Rollup with @rollup/wasm-node fallback (literal match).');
      } else {
        console.warn('[ensure-rollup-wasm] Warning: Could not locate ERR_DLOPEN_FAILED block in native.js');
      }
    }
  } else {
    console.log('[ensure-rollup-wasm] Rollup native.js already patched.');
  }
} else {
  console.log('[ensure-rollup-wasm] node_modules/rollup/dist/native.js not found.');
}

