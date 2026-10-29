// Adapta solo el chrome del visor pineado. Nunca traduce celdas ni nombres de hojas.
const LABELS = new Map([
  ['Formula bar', 'Fórmula'],
  ['Hide formula bar', 'Ocultar barra de fórmulas'],
  ['Expand Formula Bar (Ctrl+Shift+U)', 'Ampliar barra de fórmulas (Ctrl+Shift+U)'],
  ['Spreadsheet grid', 'Hoja de cálculo'],
  ['Sheet tabs', 'Hojas'],
  ['Scroll tabs left', 'Desplazar hojas a la izquierda'],
  ['Scroll tabs right', 'Desplazar hojas a la derecha'],
  ['Zoom out', 'Reducir zoom'],
  ['Zoom Out', 'Reducir zoom'],
  ['Zoom in', 'Aumentar zoom'],
  ['Zoom In', 'Aumentar zoom'],
  ['Zoom level', 'Nivel de zoom'],
  ['Click to edit', 'Cambiar zoom'],
  ['Hide status bar', 'Ocultar barra de estado'],
])
const STATUS = new Map([
  ['Ready', 'Listo'],
  ['Count', 'Conteo'],
  ['Count:', 'Conteo:'],
  ['Sum', 'Suma'],
  ['Average', 'Promedio'],
  ['Min', 'Mínimo'],
  ['Max', 'Máximo'],
])

export function installMogPresentation(root) {
  const apply = () => {
    observer.disconnect()
    for (const node of root.querySelectorAll(
      '[data-testid="debug-record-button"], [title="Split view coming soon"]'
    )) {
      node.hidden = true
      node.setAttribute('aria-hidden', 'true')
      node.setAttribute('tabindex', '-1')
      if ('disabled' in node) node.disabled = true
    }
    for (const node of root.querySelectorAll('[aria-label], [title]')) {
      for (const attribute of ['aria-label', 'title']) {
        const value = node.getAttribute(attribute)
        const zoom = value?.match(/^Click to edit zoom \((.+)\)$/)
        const translated = LABELS.get(value) ?? (zoom ? `Cambiar zoom (${zoom[1]})` : undefined)
        if (translated) node.setAttribute(attribute, translated)
      }
    }
    for (const node of root.querySelectorAll('span')) {
      if (node.children.length || node.closest('[role="grid"], [role="tablist"]')) continue
      const translated = STATUS.get(node.textContent.trim())
      if (translated) node.textContent = translated
    }
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-label', 'title'],
    })
  }
  const observer = new MutationObserver(apply)
  apply()
  return () => observer.disconnect()
}
