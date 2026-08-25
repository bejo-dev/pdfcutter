import { defineConfig, type Plugin } from "vite";

function renamePdfWorkerExtension(): Plugin {
  return {
    name: "rename-pdf-worker-extension",
    generateBundle(_, bundle) {
      const workerAsset = Object.values(bundle).find(
        (output) =>
          output.type === "asset" &&
          output.fileName.includes("pdf.worker.min-") &&
          output.fileName.endsWith(".mjs"),
      );

      if (workerAsset?.type !== "asset") {
        throw new Error("The PDF.js worker asset was not emitted.");
      }

      const renamedFileName = workerAsset.fileName.replace(/\.mjs$/, ".js");
      delete bundle[workerAsset.fileName];
      this.emitFile({
        fileName: renamedFileName,
        source: workerAsset.source,
        type: "asset",
      });

      for (const output of Object.values(bundle)) {
        if (output.type === "chunk") {
          output.code = output.code.replaceAll(workerAsset.fileName, renamedFileName);
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [renamePdfWorkerExtension()],
});
