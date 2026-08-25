import { PageSizes, PDFDocument } from "pdf-lib";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist";
import "./style.css";

GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

type Selection = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type Point = {
  x: number;
  y: number;
};

type ResizeCorner = "nw" | "ne" | "se" | "sw";

const A4_MARGIN_POINTS = (20 / 25.4) * 72;
const EXPORT_PIXELS_PER_POINT = 2.5;
const MINIMUM_SELECTION_PIXELS = 8;

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
}

const body = document.body;
const fileInput = requireElement<HTMLInputElement>("#file-input");
const dropZone = requireElement<HTMLElement>("#drop-zone");
const workspace = requireElement<HTMLElement>("#workspace");
const fileName = requireElement<HTMLElement>("#file-name");
const fileMeta = requireElement<HTMLElement>("#file-meta");
const replaceButton = requireElement<HTMLButtonElement>("#replace-button");
const previousButton = requireElement<HTMLButtonElement>("#previous-page");
const nextButton = requireElement<HTMLButtonElement>("#next-page");
const pageNumberInput = requireElement<HTMLInputElement>("#page-number");
const pageCount = requireElement<HTMLElement>("#page-count");
const exportButton = requireElement<HTMLButtonElement>("#export-button");
const selectionGuidance = requireElement<HTMLElement>("#selection-guidance");
const viewer = requireElement<HTMLElement>("#viewer");
const loadingCard = requireElement<HTMLElement>("#loading-card");
const loadingMessage = requireElement<HTMLElement>("#loading-message");
const pageStage = requireElement<HTMLButtonElement>("#page-stage");
const pdfCanvas = requireElement<HTMLCanvasElement>("#pdf-canvas");
const selectionBox = requireElement<HTMLElement>("#selection-box");
const selectionLabel = requireElement<HTMLElement>("#selection-label");
const statusMessage = requireElement<HTMLElement>("#status-message");

let pdfDocument: PDFDocumentProxy | null = null;
let renderedPage: PDFPageProxy | null = null;
let loadingTask: ReturnType<typeof getDocument> | null = null;
let renderTask: ReturnType<PDFPageProxy["render"]> | null = null;
let renderSequence = 0;
let currentPageNumber = 1;
let currentFileName = "document.pdf";
let selection: Selection | null = null;
let dragOrigin: Point | null = null;
let resizeTimer: number | undefined;
let lastViewerWidth = 0;
let lastViewerHeight = 0;

function setStatus(message: string, isError = false): void {
  statusMessage.textContent = message;
  statusMessage.classList.toggle("is-error", isError);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function getViewerContentSize(): { width: number; height: number } {
  const styles = window.getComputedStyle(viewer);
  const horizontalPadding =
    Number.parseFloat(styles.paddingLeft) + Number.parseFloat(styles.paddingRight);
  const verticalPadding =
    Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);

  return {
    width: Math.max(1, viewer.clientWidth - horizontalPadding),
    height: Math.max(1, viewer.clientHeight - verticalPadding),
  };
}

function getNormalizedPointer(event: PointerEvent): Point {
  const bounds = pageStage.getBoundingClientRect();
  return {
    x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
    y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1),
  };
}

function getResizeOrigin(corner: ResizeCorner, currentSelection: Selection): Point {
  switch (corner) {
    case "nw":
      return {
        x: currentSelection.x + currentSelection.width,
        y: currentSelection.y + currentSelection.height,
      };
    case "ne":
      return {
        x: currentSelection.x,
        y: currentSelection.y + currentSelection.height,
      };
    case "se":
      return { x: currentSelection.x, y: currentSelection.y };
    case "sw":
      return {
        x: currentSelection.x + currentSelection.width,
        y: currentSelection.y,
      };
  }
}

function clearSelection(): void {
  selection = null;
  dragOrigin = null;
  selectionBox.classList.remove("is-visible", "is-drawing", "is-resizing");
  exportButton.disabled = true;
  selectionGuidance.classList.remove("has-selection");
  selectionGuidance.innerHTML =
    '<span class="guidance-dot" aria-hidden="true"></span>Click and drag on the page to select an area';
}

function updateSelectionDisplay(): void {
  if (!selection || !renderedPage) {
    clearSelection();
    return;
  }

  selectionBox.style.left = `${selection.x * 100}%`;
  selectionBox.style.top = `${selection.y * 100}%`;
  selectionBox.style.width = `${selection.width * 100}%`;
  selectionBox.style.height = `${selection.height * 100}%`;
  selectionBox.classList.add("is-visible");

  const baseViewport = renderedPage.getViewport({ scale: 1 });
  const widthMillimeters = (baseViewport.width * selection.width * 25.4) / 72;
  const heightMillimeters = (baseViewport.height * selection.height * 25.4) / 72;
  selectionLabel.textContent = `${Math.round(widthMillimeters)} × ${Math.round(heightMillimeters)} mm`;
  if (dragOrigin) {
    selectionGuidance.textContent = selectionBox.classList.contains("is-resizing")
      ? "Release to apply the new size"
      : "Release to finish the selection";
  } else {
    selectionGuidance.textContent = "Drag a corner to resize, or drag elsewhere to replace";
  }
  selectionGuidance.classList.add("has-selection");
  exportButton.disabled = dragOrigin !== null;
}

function updateNavigation(): void {
  const pageTotal = pdfDocument?.numPages ?? 1;
  pageNumberInput.value = String(currentPageNumber);
  pageNumberInput.max = String(pageTotal);
  pageCount.textContent = `of ${pageTotal}`;
  previousButton.disabled = currentPageNumber <= 1;
  nextButton.disabled = currentPageNumber >= pageTotal;
}

function setRenderingState(isRendering: boolean, message = "Rendering page..."): void {
  loadingMessage.textContent = message;
  loadingCard.classList.toggle("is-hidden", !isRendering);
  pageStage.classList.toggle("is-hidden", isRendering);
  pageNumberInput.disabled = isRendering;
  previousButton.disabled = isRendering || currentPageNumber <= 1;
  nextButton.disabled = isRendering || currentPageNumber >= (pdfDocument?.numPages ?? 1);
  exportButton.disabled = isRendering || !selection;
}

async function renderPage(pageNumber: number, preserveSelection = false): Promise<void> {
  if (!pdfDocument) {
    return;
  }

  const sequence = ++renderSequence;
  renderTask?.cancel();
  renderTask = null;
  setRenderingState(true);
  if (!preserveSelection) {
    clearSelection();
  }

  try {
    const page = await pdfDocument.getPage(pageNumber);
    if (sequence !== renderSequence) {
      return;
    }

    const baseViewport = page.getViewport({ scale: 1 });
    const viewerContentSize = getViewerContentSize();
    const availableWidth = Math.min(980, viewerContentSize.width);
    const displayScale = Math.min(
      1.5,
      availableWidth / baseViewport.width,
      viewerContentSize.height / baseViewport.height,
    );
    const viewport = page.getViewport({ scale: displayScale });
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2.5);
    const context = pdfCanvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error("Canvas rendering is not supported in this browser.");
    }

    pdfCanvas.width = Math.ceil(viewport.width * pixelRatio);
    pdfCanvas.height = Math.ceil(viewport.height * pixelRatio);
    pdfCanvas.style.width = `${viewport.width}px`;
    pdfCanvas.style.height = `${viewport.height}px`;
    pageStage.style.width = `${viewport.width}px`;
    pageStage.style.height = `${viewport.height}px`;

    renderTask = page.render({
      canvas: pdfCanvas,
      canvasContext: context,
      viewport,
      transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      background: "rgb(255, 255, 255)",
    });
    await renderTask.promise;

    if (sequence !== renderSequence) {
      return;
    }
    currentPageNumber = pageNumber;
    renderedPage = page;
    lastViewerWidth = viewer.clientWidth;
    lastViewerHeight = viewer.clientHeight;
    renderTask = null;
    setRenderingState(false);
    updateNavigation();
    if (preserveSelection) {
      updateSelectionDisplay();
    }
    setStatus("");
  } catch (error) {
    if (error instanceof Error && error.name === "RenderingCancelledException") {
      return;
    }
    setRenderingState(false);
    setStatus(error instanceof Error ? error.message : "The page could not be rendered.", true);
  }
}

async function loadPdf(file: File): Promise<void> {
  const looksLikePdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (!looksLikePdf) {
    setStatus("Please choose a PDF file.", true);
    return;
  }

  setStatus("");
  body.classList.add("has-document");
  workspace.classList.remove("is-hidden");
  fileName.textContent = file.name;
  fileMeta.textContent = formatFileSize(file.size);
  setRenderingState(true, "Opening your PDF...");
  clearSelection();

  try {
    renderTask?.cancel();
    if (loadingTask) {
      await loadingTask.destroy();
    }

    const fileBytes = new Uint8Array(await file.arrayBuffer());
    loadingTask = getDocument({ data: fileBytes });
    pdfDocument = await loadingTask.promise;
    currentFileName = file.name;
    currentPageNumber = 1;
    fileMeta.textContent = `${formatFileSize(file.size)} · ${pdfDocument.numPages} ${
      pdfDocument.numPages === 1 ? "page" : "pages"
    }`;
    updateNavigation();
    await renderPage(1);
  } catch (error) {
    pdfDocument = null;
    renderedPage = null;
    setRenderingState(false);
    setStatus(
      error instanceof Error
        ? `Could not open this PDF: ${error.message}`
        : "Could not open this PDF.",
      true,
    );
  } finally {
    fileInput.value = "";
  }
}

async function goToPage(requestedPage: number): Promise<void> {
  if (!pdfDocument) {
    return;
  }
  const page = clamp(Math.trunc(requestedPage), 1, pdfDocument.numPages);
  pageNumberInput.value = String(page);
  if (page !== currentPageNumber) {
    await renderPage(page);
  }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("The selected area could not be converted to an image."));
      }
    }, "image/png");
  });
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

async function exportSelection(): Promise<void> {
  if (!renderedPage || !selection) {
    return;
  }

  const selectedArea = { ...selection };
  exportButton.disabled = true;
  exportButton.classList.add("is-loading");
  setStatus("Preparing your A4 PDF...");

  try {
    const baseViewport = renderedPage.getViewport({ scale: 1 });
    const naturalWidth = baseViewport.width * selectedArea.width;
    const naturalHeight = baseViewport.height * selectedArea.height;
    const [a4Width, a4Height] = PageSizes.A4;
    const printableWidth = a4Width - A4_MARGIN_POINTS * 2;
    const printableHeight = a4Height - A4_MARGIN_POINTS * 2;
    const fitScale = Math.min(1, printableWidth / naturalWidth, printableHeight / naturalHeight);
    const placedWidth = naturalWidth * fitScale;
    const placedHeight = naturalHeight * fitScale;
    const rasterScale = fitScale * EXPORT_PIXELS_PER_POINT;
    const exportViewport = renderedPage.getViewport({ scale: rasterScale });
    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = Math.max(1, Math.ceil(naturalWidth * rasterScale));
    cropCanvas.height = Math.max(1, Math.ceil(naturalHeight * rasterScale));
    const cropContext = cropCanvas.getContext("2d", { alpha: false });
    if (!cropContext) {
      throw new Error("Canvas export is not supported in this browser.");
    }

    await renderedPage.render({
      canvas: cropCanvas,
      canvasContext: cropContext,
      viewport: exportViewport,
      transform: [
        1,
        0,
        0,
        1,
        -selectedArea.x * exportViewport.width,
        -selectedArea.y * exportViewport.height,
      ],
      background: "rgb(255, 255, 255)",
    }).promise;

    const imageBlob = await canvasToBlob(cropCanvas);
    const outputDocument = await PDFDocument.create();
    outputDocument.setCreator("PDF Cutter");
    outputDocument.setProducer("pdf-lib");
    outputDocument.setTitle(`Selection from ${currentFileName}`);
    const image = await outputDocument.embedPng(await imageBlob.arrayBuffer());
    const outputPage = outputDocument.addPage(PageSizes.A4);
    outputPage.drawImage(image, {
      x: A4_MARGIN_POINTS,
      y: a4Height - A4_MARGIN_POINTS - placedHeight,
      width: placedWidth,
      height: placedHeight,
    });

    const outputBytes = await outputDocument.save();
    const baseName = currentFileName.replace(/\.pdf$/i, "") || "document";
    const outputBuffer = new ArrayBuffer(outputBytes.byteLength);
    new Uint8Array(outputBuffer).set(outputBytes);
    downloadBlob(
      new Blob([outputBuffer], { type: "application/pdf" }),
      `${baseName}-selection-p${currentPageNumber}.pdf`,
    );
    setStatus("Your cropped A4 PDF has been downloaded.");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "The PDF could not be exported.", true);
  } finally {
    exportButton.classList.remove("is-loading");
    exportButton.disabled = !selection;
  }
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) {
    void loadPdf(file);
  }
});

replaceButton.addEventListener("click", () => fileInput.click());

for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
  });
}

dropZone.addEventListener("drop", (event) => {
  const file = event.dataTransfer?.files[0];
  if (file) {
    void loadPdf(file);
  }
});

previousButton.addEventListener("click", () => void goToPage(currentPageNumber - 1));
nextButton.addEventListener("click", () => void goToPage(currentPageNumber + 1));

pageNumberInput.addEventListener("change", () => {
  void goToPage(Number(pageNumberInput.value));
});

pageNumberInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    pageNumberInput.blur();
  }
});

pageStage.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !renderedPage) {
    return;
  }
  event.preventDefault();
  pageStage.focus({ preventScroll: true });
  pageStage.setPointerCapture(event.pointerId);
  const handle =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-resize-handle]")
      : null;
  const corner = handle?.dataset.resizeHandle as ResizeCorner | undefined;

  if (corner && selection) {
    dragOrigin = getResizeOrigin(corner, selection);
    selectionBox.classList.add("is-resizing");
  } else {
    dragOrigin = getNormalizedPointer(event);
    selection = { x: dragOrigin.x, y: dragOrigin.y, width: 0, height: 0 };
    selectionBox.classList.add("is-visible", "is-drawing");
  }
  updateSelectionDisplay();
});

pageStage.addEventListener("pointermove", (event) => {
  if (!dragOrigin || !pageStage.hasPointerCapture(event.pointerId)) {
    return;
  }
  const point = getNormalizedPointer(event);
  selection = {
    x: Math.min(dragOrigin.x, point.x),
    y: Math.min(dragOrigin.y, point.y),
    width: Math.abs(point.x - dragOrigin.x),
    height: Math.abs(point.y - dragOrigin.y),
  };
  updateSelectionDisplay();
});

function finishSelection(event: PointerEvent): void {
  if (!dragOrigin) {
    return;
  }
  dragOrigin = null;
  selectionBox.classList.remove("is-drawing", "is-resizing");
  if (pageStage.hasPointerCapture(event.pointerId)) {
    pageStage.releasePointerCapture(event.pointerId);
  }
  if (
    !selection ||
    selection.width * pageStage.clientWidth < MINIMUM_SELECTION_PIXELS ||
    selection.height * pageStage.clientHeight < MINIMUM_SELECTION_PIXELS
  ) {
    clearSelection();
    setStatus("Drag a slightly larger rectangle to make a selection.", true);
    return;
  }
  setStatus("");
  updateSelectionDisplay();
}

pageStage.addEventListener("pointerup", finishSelection);
pageStage.addEventListener("pointercancel", finishSelection);

pageStage.addEventListener("keydown", (event) => {
  if (event.key === "Escape" || event.key === "Delete" || event.key === "Backspace") {
    clearSelection();
    setStatus("Selection cleared.");
  }
});

exportButton.addEventListener("click", () => void exportSelection());

const resizeObserver = new ResizeObserver(() => {
  if (
    !pdfDocument ||
    !renderedPage ||
    (Math.abs(viewer.clientWidth - lastViewerWidth) < 12 &&
      Math.abs(viewer.clientHeight - lastViewerHeight) < 12)
  ) {
    return;
  }
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => void renderPage(currentPageNumber, true), 160);
});
resizeObserver.observe(viewer);
