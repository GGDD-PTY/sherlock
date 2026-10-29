// El worker de pdfjs no publica tipos. Se importa solo por su efecto (registra
// `globalThis.pdfjsWorker` al cargarse) y nunca se lee un símbolo suyo.
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs'
