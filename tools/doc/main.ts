#!/usr/bin/env ts-node
import * as fs from "fs-extra";
import * as path from "path";
import * as glob from "glob";
import * as  ts from "typescript";
import * as cachedir from "cachedir";
import {URL} from "url";

function transformers(containingFile: string, relativeDeps: string[]) {
  const swapImport = <T extends ts.Node>(
    context: ts.TransformationContext
  ) => (rootNode: T) => {
    const visit = (node: ts.Node): ts.VisitResult<ts.Node> => {
      node = ts.visitEachChild(node, visit, context);
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        let modulePath = "";
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const moduleName = node.moduleSpecifier.text;
          if (moduleName.startsWith("http://") || moduleName.startsWith("https://")) {
            function resolveUrlModule(url: string): string {
              const u = new URL(url);
              let remoteFilePath = path.join(cachedir("deno"), "deps");
              const scheme = u.protocol.slice(0, -1);
              const hostname = u.hostname;
              remoteFilePath += `/${scheme}/${hostname}`;
              const port = u.port;
              if (port.length > 0) {
                remoteFilePath += "_PORT" + port;
              }
              remoteFilePath += u.pathname;
              if (!u.pathname.match(/\.[jt]sx?$/)) {
                const headers = fs.readFileSync(remoteFilePath + ".headers.json").toString();
                const meta = JSON.parse(headers);
                const {redirect_to} = meta;
                if (redirect_to) {
                  return resolveUrlModule(redirect_to);
                }
              }
              return remoteFilePath;
            }

            modulePath = resolveUrlModule(moduleName);
          } else if (moduleName.startsWith("file://")) {
            const u = new URL(moduleName);
            modulePath = (u.pathname);
          } else {
            const resolved = path.resolve(path.dirname(containingFile), moduleName);
            relativeDeps.push(resolved);
            modulePath = (resolved);
          }
          const m = modulePath.match(/^(.+?)\.[jt]sx?$/);
          if (m) {
            const [_, noExt] = m;
            node.moduleSpecifier = ts.createStringLiteral(noExt);
          } else {
            node.moduleSpecifier = ts.createStringLiteral(modulePath);
          }
        }
      }
      return node;
    };
    return ts.visitNode(rootNode, visit);
  };
  return [swapImport];
}

async function main() {
  while ((process.argv.shift() !== __filename)) {
  }
  const globs = process.argv;
  const destDir = "../../tmp";
  const printer = ts.createPrinter();
  const resolvedMap = new Map<string, boolean>();
  let stack: string[] = [];
  for (const pat of globs) {
    for (const file of glob.sync(pat)) {
      stack.push(file)
    }
  }
  let file: string|undefined;
  while((file = stack.shift())) {
    if (resolvedMap.has(file)) {
      continue;
    }
    const code = (await fs.readFile(file)).toString();
    const src = ts.createSourceFile(file, code, ts.ScriptTarget.ESNext);
    const relativeDeps:string[] = [];
    const result = ts.transform(src, transformers(file, relativeDeps));
    const out = printer.printFile(result.transformed[0] as ts.SourceFile);
    // const relative = path.relative(destDir, file);
    // const destpath = path.relative(destDir, );
    const destParentDir = path.dirname(path.resolve(destDir));
    const relative = path.relative(destParentDir, file);
    const destpath = path.join(destDir, relative);
    const destdir = path.dirname(destpath);
    if (!(await fs.pathExists(destdir))) {
      await fs.mkdirp(destdir);
    }
    console.log("generating "+path.resolve(destpath));
    await fs.writeFile(destpath, out);
    stack.push(...relativeDeps);
    resolvedMap.set(file, true);
  }
}

main();