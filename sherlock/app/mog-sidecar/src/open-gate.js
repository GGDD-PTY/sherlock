// Un iframe del sidecar representa una sola apertura autorizada. Este gate
// sella el primer payload y evita que mensajes duplicados inicien trabajo o
// que callbacks de una generacion fallida completen despues de un retry.

export function createMogOpenController({ open, onFailure }) {
  let state = 'idle'
  let generation = 0

  const accept = (payload) => {
    if (state !== 'idle') return false
    state = 'opening'
    const currentGeneration = ++generation
    let failureHandled = false

    const attempt = {
      isCurrent: () => state === 'opening' && generation === currentGeneration,
      markOpened: () => {
        if (!attempt.isCurrent()) return false
        state = 'opened'
        return true
      },
      fail: () => {
        if (!attempt.isCurrent()) return false
        state = 'idle'
        return true
      },
      handleFailure: () => {
        if (generation !== currentGeneration || failureHandled) return 'ignore'
        if (state === 'opening') state = 'idle'
        else if (state !== 'opened') return 'ignore'
        failureHandled = true
        return 'report'
      },
    }

    Promise.resolve()
      .then(() => open(payload, attempt))
      .catch((error) => {
        if (attempt.handleFailure() === 'report') onFailure(error)
      })
    return true
  }

  return { accept }
}
