# PDF Cutter

A browser-only PDF cropper built with vanilla TypeScript. Open a PDF, navigate to a page,
draw an axis-aligned rectangle, and export that section on a new single-page A4 PDF.

The selected content is placed in the top-left of the output with 20 mm margins. It keeps
its original physical size when possible and scales down proportionally if it is too large
for the printable A4 area.

## Privacy

PDF rendering and export happen entirely in the browser. Files are never uploaded to a
server, and the application makes no network request for document processing.

## Development

```sh
npm install
npm run dev
```

## Verification

```sh
npm run lint
npm run typecheck
npm run build
```
