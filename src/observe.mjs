import path from 'node:path';
import ts from 'typescript';

const sourceExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const typeScriptExtensions = new Set(['.ts', '.tsx', '.mts', '.cts']);
const resolutionExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

export function isSourcePath(file) {
  return sourceExtensions.has(path.posix.extname(file).toLowerCase());
}

function isTypeScriptPath(file) {
  return typeScriptExtensions.has(path.posix.extname(file).toLowerCase());
}

function sourceKind(file) {
  const extension = path.posix.extname(file).toLowerCase();
  if (extension === '.tsx' || extension === '.jsx') return ts.ScriptKind.TSX;
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function relativeCandidates(from, specifier) {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  if (joined === '..' || joined.startsWith('../')) return [];

  const extension = path.posix.extname(joined).toLowerCase();
  if (!extension) return [joined, ...resolutionExtensions.map(candidate => `${joined}${candidate}`), ...resolutionExtensions.map(candidate => `${joined}/index${candidate}`)];

  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    const replacementExtensions = extension === '.mjs' ? ['.mts', '.mjs'] : extension === '.cjs' ? ['.cts', '.cjs'] : ['.ts', '.tsx', '.js'];
    const preferred = isTypeScriptPath(from) ? replacementExtensions : [extension, ...replacementExtensions];
    return [...new Set(preferred.map(candidate => `${joined.slice(0, -extension.length)}${candidate}`))];
  }

  return [joined];
}

function resolveRelative(from, specifier, knownPaths) {
  const candidates = relativeCandidates(from, specifier);
  if (candidates.length === 0) return { value: null, candidates: [], reason: `outside:${specifier}` };
  const found = candidates.find(candidate => knownPaths.has(candidate));
  if (found) return { value: found, candidates, reason: null };

  // Keep a useful prospective edge for a planned TypeScript target. This lets
  // a later consumer lookup reason about a target that does not exist yet.
  return { value: candidates[0], candidates, reason: `unresolved:${specifier}` };
}

function dynamicDescription(node, sourceFile) {
  const text = node.arguments?.[0]?.getText(sourceFile) ?? '';
  return text ? `dynamic:${text}` : 'dynamic:unknown';
}

/**
 * Observes only static module edges in one source file. It deliberately does
 * not build a TypeScript program, resolve package aliases, or infer runtime
 * relationships. Those remain visible gaps in `unknowns`.
 */
export function observeSource(file, text, knownPaths) {
  if (!isSourcePath(file)) return { path: file, imports: [], exports: [], unknowns: [], candidates: [] };

  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, sourceKind(file));
  const imports = new Set();
  const exports = new Set();
  const unknowns = new Set();
  const candidates = new Set();

  const addSpecifier = (specifier, destination) => {
    if (specifier.startsWith('.')) {
      const resolved = resolveRelative(file, specifier, knownPaths);
      if (resolved.value) destination.add(resolved.value);
      resolved.candidates.forEach(candidate => candidates.add(candidate));
      if (resolved.reason) unknowns.add(resolved.reason);
      return;
    }
    if (specifier.startsWith('node:')) return;
    unknowns.add(`bare:${specifier}`);
  };

  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      addSpecifier(node.moduleSpecifier.text, ts.isImportDeclaration(node) ? imports : exports);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
      addSpecifier(node.moduleReference.expression.text, imports);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        unknowns.add(dynamicDescription(node, sourceFile));
      }
    } else if (ts.isImportTypeNode(node)) {
      unknowns.add(`dynamic:${node.argument.getText(sourceFile)}`);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return {
    path: file,
    imports: [...imports].sort(),
    exports: [...exports].sort(),
    unknowns: [...unknowns].sort(),
    candidates: [...candidates].sort(),
  };
}
