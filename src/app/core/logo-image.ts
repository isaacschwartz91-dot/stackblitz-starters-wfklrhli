/**
 * Preparing an uploaded logo for use.
 *
 * The file that arrives is whatever was on the phone: often several thousand
 * pixels wide and a few megabytes. It is going to be drawn about 28 pixels
 * tall in the top bar, and — when there is no file store to put it in — it
 * has to fit inside a settings row that every device downloads at start-up.
 * So it is redrawn small before anything else happens to it.
 */

/** Longest edge, in pixels, of a stored logo. Generous for a bar 28px tall. */
const MAX_EDGE = 320;

/** Anything above this after resizing is a sign the image is not a logo. */
const MAX_STORED_BYTES = 400_000;

export interface PreparedLogo {
  /** PNG, resized, ready to upload or embed. */
  blob: Blob;
  /** The same image as a data URL, for when there is nowhere to upload it. */
  dataUrl: string;
  width: number;
  height: number;
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}

/**
 * Redraw an image file at logo size.
 *
 * SVG is left alone: it is already small, and rasterising it would throw away
 * the one format that stays sharp on every screen.
 */
export async function prepareLogo(file: File): Promise<PreparedLogo> {
  if (!isImageFile(file)) {
    throw new Error('That file is not an image.');
  }

  if (file.type === 'image/svg+xml') {
    const text = await file.text();
    if (text.length > MAX_STORED_BYTES) {
      throw new Error('That SVG is too large to store. Try a simpler version.');
    }
    const dataUrl = await readAsDataUrl(file);
    return { blob: file, dataUrl, width: 0, height: 0 };
  }

  const bitmap = await loadBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('This browser could not read that image.');
  context.drawImage(bitmap, 0, 0, width, height);

  // PNG, so a logo with a transparent background keeps it.
  const dataUrl = canvas.toDataURL('image/png');
  const blob = await canvasBlob(canvas);
  if (blob.size > MAX_STORED_BYTES) {
    throw new Error('That image is too detailed to store as a logo. Try a simpler one.');
  }

  return { blob, dataUrl, width, height };
}

function loadBitmap(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That image could not be opened.'));
    };
    image.src = url;
  });
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new Error('That image could not be converted.'));
      else resolve(blob);
    }, 'image/png');
  });
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.readAsDataURL(file);
  });
}
