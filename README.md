# PDF Workbench

A PDF manager that runs entirely in the browser. Open, read, search, annotate, sign, fill forms, merge, split, reorder, rotate and export PDFs. Files never leave the machine: rendering uses [pdf.js](https://mozilla.github.io/pdf.js/) and editing/export uses [pdf-lib](https://pdf-lib.js.org/), both loaded from cdnjs.

## Run it

Any static file server works:

```bash
python3 -m http.server 8765 --directory pdf-workbench
```

Then open <http://localhost:8765>. The app starts with a generated three-page sample document so every feature can be tried immediately.

## Features

**Read**
- Continuous scrolling viewer with lazy rendering, fit width / fit page / zoom presets, ⌘/Ctrl + wheel zoom.
- Page thumbnails, page indicator, paper-size readout (Letter, A4, … in pt and mm).
- Full-text search with match highlighting and a results list.
- "Copy text" tool for selecting and copying page text; export all text as `.txt`.
- Password-protected files can be opened (prompt); metadata is read from the file.

**Pages**
- Start in **Files**: drag a file card or use its up/down arrows to move all of its pages together. Expand **Show pages** to arrange the pages within that file.
- Use **All pages** for a combined view and for moving pages between files. File cards show a notice when their pages are mixed with other files; moving that file brings its pages back together without changing their internal order.
- Drag thumbnails to reorder (Shift-click for a range, ⌘/Ctrl-click for individual pages). A selected range moves together. **Select all** inside a file selects its pages; the page toolbar also offers up/down controls.
- Rotate, duplicate, delete, insert blank pages, insert another PDF at a position.
- Merge: **Add** appends any number of PDFs; PNG/JPEG/WebP images are added as pages.
- Split: extract the selected pages to a new PDF.

**Annotate**
- Text (standard PDF fonts, size, colour, multi-line), freehand pen, highlight (multiply blend), box, ellipse, arrow, cover-up box, images.
- Select, move, resize (corner handle), edit text by double-click, delete, live style editing.
- Annotations stay attached to pages through rotation and reordering.

**Sign**
- Draw a signature on a pad, type it in a script font, or upload a scanned image (white background removed).
- Signatures are kept in the browser (localStorage) for reuse; place with a click, resize with the handle.

**Forms**
- Text fields, checkboxes, radio groups, dropdowns and list boxes are listed per file with their page numbers. Values are written into the file and rendered on the pages; export flattens them.

**Document**
- Metadata (title, author, subject, keywords), text watermark (size, angle, colour, opacity), page numbers (format, position, size, start number).
- Export the whole document or the selection as PDF, or the current page as PNG.
- Undo / redo for every page and annotation operation.

**Cloud library (optional, Supabase)**
- Sign in with an email link, save the current document to a private Supabase Storage bucket, open or add saved documents from any device, download or delete them.
- Configure it with a `config.js` next to `index.html`:

```js
window.PDFWB_CONFIG = {
  supabaseUrl: 'https://<project-ref>.supabase.co',
  supabaseAnonKey: '<publishable (anon) key>',
  bucket: 'documents',
  webUrl: 'https://<where the app is hosted>/',
};
```

- Create the bucket and row-level policies once (SQL editor or migration): see `supabase/setup.sql`.
- In Supabase Auth → URL configuration, set the Site URL to where the app is hosted and add it to the redirect allow-list, so the sign-in link returns to the app.

## Keyboard

| Keys | Action |
| --- | --- |
| ⌘O / ⌘S / ⌘F | Open / Export / Search |
| ⌘Z / ⇧⌘Z | Undo / Redo |
| ⌘+ / ⌘− / ⌘0 | Zoom in / out / fit width |
| V C T P H R E A W I | Select, Copy text, Text, Pen, Highlight, Box, Ellipse, Arrow, Cover, Image |
| ⌫ | Delete selected annotation, or selected pages when the page list is focused |
| Esc | Back to Select |

(Ctrl instead of ⌘ on Windows and Linux.)

## Limitations

- Signatures are visual (an image drawn on the page), not cryptographic digital signatures.
- The cover-up tool hides content visually; it is not redaction, the underlying text stays in the file.
- Text annotations use the standard PDF fonts, which cover Latin (WinAnsi) characters only.
- Encrypted or damaged files that pdf-lib cannot parse are still viewable; on export those pages are rasterised to images.
- Existing PDF annotations and form fields are preserved when pages are copied, but forms are flattened on export.

## Files

- `index.html` markup, dialogs and the icon set
- `styles.css` theme tokens (light and dark), layout, components
- `app.js` the application: sources, page model, viewer, annotation engine, search, forms, signatures, export
- `cloud.js` the optional Supabase library (sign-in, save, open, delete); `config.js` holds the project URL and publishable key
- `supabase/setup.sql` storage bucket and access policies

`window.PDFWorkbench` exposes `state`, `buildPdf()`, `openFiles()` and `pdfjsLib` for scripting and debugging.
