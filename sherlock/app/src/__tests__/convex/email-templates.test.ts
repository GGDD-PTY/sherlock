// ============================================================================
// EMAIL — el timbre no filtra identidades y nunca tumba la mutación
// ============================================================================
// Contratos: (1) el contenido de cada evento es ESTÁTICO — sin nombres, sin
// títulos, sin montos; lo único variable es el link de entrada. (2) Sin
// RESEND_API_KEY el timbre es un no-op que ni toca la base. (3) Un fallo del
// envío jamás propaga: la campanita in-app es la fuente de verdad.
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildProductEmail, type ProductEmailEvent } from '../../../convex/_helpers/emailTemplates'
import { sendProductEmail } from '../../../convex/email'

// Las plantillas de conexión, NDA y Q&A salieron con el subsistema de
// transacciones ([F] 2026-09-17): el único evento con emisor vivo es la
// publicación de un entregable.
const EVENTS: ProductEmailEvent[] = ['deliverable_published']
const APP_URL = 'https://dev.sherlock.capital'

describe('buildProductEmail — contenido estático en español, con link de entrada', () => {
  it.each(EVENTS)('%s produce subject, html y text con el link de entrada', (event) => {
    const email = buildProductEmail(event, APP_URL)

    expect(email.subject.length).toBeGreaterThan(10)
    expect(email.text).toContain(`${APP_URL}/es/`)
    expect(email.html).toContain(`${APP_URL}/es/`)
    // Estático de verdad: dos construcciones son idénticas — no hay ningún
    // dato de contraparte interpolable.
    expect(buildProductEmail(event, APP_URL)).toEqual(email)
  })

  it('el copy en español es tuteo panameño, nunca voseo', () => {
    // Sólo las formas voseantes: tenés/podés/sabés y los imperativos con acento
    // final (revisá, firmá, entrá). "Revisa"/"Firma" sin acento son tuteo.
    const voseo = /\b(tenés|podés|sabés|revisá|firmá|entrá|vos)\b/iu
    for (const event of EVENTS) {
      const { subject, text } = buildProductEmail(event, APP_URL)
      expect(`${subject} ${text}`).not.toMatch(voseo)
    }
  })

  it('no arrastra dobles slashes cuando appUrl trae slash final', () => {
    const email = buildProductEmail('deliverable_published', `${APP_URL}/`)
    expect(email.text).toContain(`${APP_URL}/es/my-company/documents`)
    expect(email.text).not.toContain('capital//es')
  })

  it('no reintroduce un segundo idioma: cada evento tiene UN contenido y su ruta es /es', () => {
    // [F] 2026-09-03: el sitio ships solo en español. Un mapa { es, en } acá
    // sería el regreso silencioso del locale que se cortó.
    for (const event of EVENTS) {
      const { text, html } = buildProductEmail(event, APP_URL)
      expect(text).not.toContain(`${APP_URL}/en/`)
      expect(html).not.toContain(`${APP_URL}/en/`)
    }
  })
})

describe('sendProductEmail — gating y fail-open', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function fakeCtx() {
    return {
      db: { get: vi.fn(async () => null) },
    } as unknown as Parameters<typeof sendProductEmail>[0]
  }

  it('sin RESEND_API_KEY es un no-op: ni siquiera lee la base', async () => {
    vi.stubEnv('RESEND_API_KEY', '')
    const ctx = fakeCtx()

    await sendProductEmail(ctx, {
      recipientProfileId: 'profile_1' as never,
      event: 'deliverable_published',
    })

    expect(
      (ctx as unknown as { db: { get: ReturnType<typeof vi.fn> } }).db.get
    ).not.toHaveBeenCalled()
  })

  it('con key pero sin perfil resoluble, no lanza (fail-open)', async () => {
    vi.stubEnv('RESEND_API_KEY', 'test_key')
    vi.stubEnv('RESEND_FROM_EMAIL', 'Sherlock <sender@example.com>')
    vi.stubEnv('APP_URL', 'https://app.example.com')
    const ctx = fakeCtx()

    await expect(
      sendProductEmail(ctx, {
        recipientProfileId: 'profile_1' as never,
        event: 'deliverable_published',
      })
    ).resolves.toBeUndefined()
  })

  it('un fallo interno del envío se traga con warn, nunca propaga', async () => {
    vi.stubEnv('RESEND_API_KEY', 'test_key')
    vi.stubEnv('RESEND_FROM_EMAIL', 'Sherlock <sender@example.com>')
    vi.stubEnv('APP_URL', 'https://app.example.com')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // ctx con perfil y usuario válidos pero sin runMutation: el componente de
    // Resend revienta al encolar, y ese fallo debe quedar contenido.
    const rows: Record<string, unknown> = {
      profile_1: { _id: 'profile_1', userId: 'user_1' },
      user_1: { _id: 'user_1', email: 'inversionista@example.com' },
    }
    const ctx = {
      db: { get: vi.fn(async (id: string) => rows[id] ?? null) },
    } as unknown as Parameters<typeof sendProductEmail>[0]

    await expect(
      sendProductEmail(ctx, {
        recipientProfileId: 'profile_1' as never,
        event: 'deliverable_published',
      })
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()

    warn.mockRestore()
  })
})

// ============================================================================
// ALERTA DE 5xx (A7) — mismo carril de equipo, asunto estable
// ============================================================================
// El asunto es la única parte del correo en claro en cada salto de la entrega,
// así que sólo puede llevar la plantilla de ruta. El requestId, el conteo y el
// mensaje van en el cuerpo, que sí viaja cifrado.
// ============================================================================

describe('buildServerErrorAlertEmail — el correo que despierta a un humano', () => {
  const base = {
    route: '/[locale]/vdr/[dealId]',
    errorName: 'TypeError',
    status: 500,
    message: 'no se pudo leer el documento',
    requestId: 'request-1',
    method: 'GET',
    synthetic: false,
    occurrences: 1,
    suppressedRepeats: 0,
    url: `${APP_URL}/es/admin`,
  }

  it('usa el asunto acordado y nombra la ruta, el error y el requestId', async () => {
    const { buildServerErrorAlertEmail } =
      await import('../../../convex/_helpers/teamEmailTemplates')

    const email = buildServerErrorAlertEmail(base)

    expect(email.subject).toBe('[Sherlock] Error 5xx en /[locale]/vdr/[dealId]')
    expect(email.text).toContain('TypeError')
    expect(email.text).toContain('request-1')
    expect(email.text).toContain(`${APP_URL}/es/admin`)
    expect(email.html).toContain('Error 5xx en producción')
  })

  it('dice cuántas repeticiones hubo y cuántas se silenciaron desde el aviso anterior', async () => {
    const { buildServerErrorAlertEmail } =
      await import('../../../convex/_helpers/teamEmailTemplates')

    const email = buildServerErrorAlertEmail({ ...base, occurrences: 4, suppressedRepeats: 11 })

    expect(email.text).toContain('Repeticiones en esta ventana: 4')
    expect(email.text).toContain('Repeticiones silenciadas desde el aviso anterior: 11')
  })

  it('el probe sintético se anuncia como tal para que nadie salga corriendo', async () => {
    const { buildServerErrorAlertEmail } =
      await import('../../../convex/_helpers/teamEmailTemplates')

    const email = buildServerErrorAlertEmail({
      ...base,
      route: '/api/observability/probe',
      synthetic: true,
    })

    expect(email.subject).toBe('[Sherlock] Error 5xx en /api/observability/probe')
    expect(email.text).toContain('Probe sintético de 5xx')
    expect(email.text).toContain('No hay nada roto.')
  })

  it('escapa el HTML de lo que venga en el mensaje', async () => {
    const { buildServerErrorAlertEmail } =
      await import('../../../convex/_helpers/teamEmailTemplates')

    const email = buildServerErrorAlertEmail({
      ...base,
      message: '<img src=x onerror="alert(1)">',
    })

    expect(email.html).not.toContain('<img')
    expect(email.html).toContain('&lt;img')
  })
})

// ============================================================================
// DOCUMENTOS NUEVOS — la carpeta se dice como la muestra la sala
// ============================================================================
// QA post-deploy de #776: el correo salió como «Apple Inc. Demo subió 1
// documento nuevo en room_corporate». La tanda guarda la llave; el correo dice
// la etiqueta de la sala y nunca imprime una llave cruda.
// ============================================================================

describe('buildTeamAlertEmail — documentos nuevos', () => {
  const base = {
    kind: 'COMPANY_DOCUMENTS_UPLOADED' as const,
    companyName: 'Apple Inc. Demo',
    fileCount: 1,
    folders: ['room_corporate'],
    fileNames: ['pacto-social.pdf'],
    url: `${APP_URL}/es/admin/companies/company_1/documents`,
  }

  it('nombra la carpeta con la etiqueta de la sala, no con su llave', async () => {
    const { buildTeamAlertEmail } = await import('../../../convex/_helpers/teamEmailTemplates')

    const email = buildTeamAlertEmail(base)

    expect(email.subject).toBe('[Sherlock] Documentos nuevos: Apple Inc. Demo')
    expect(email.text).toContain('Apple Inc. Demo subió 1 documento nuevo en 2. Corporativos.')
    expect(email.html).toContain('en 2. Corporativos.')
    expect(`${email.subject} ${email.text} ${email.html}`).not.toContain('room_')
  })

  it('junta varias carpetas sin repetirlas y resuelve alias y desconocidas', async () => {
    const { buildTeamAlertEmail } = await import('../../../convex/_helpers/teamEmailTemplates')

    const email = buildTeamAlertEmail({
      ...base,
      fileCount: 4,
      folders: ['teaser', 'financials', 'General', 'room_financial', 'teaser'],
    })

    expect(email.text).toContain(
      'subió 4 documentos nuevos en 5. Materiales de mercadeo, 3. Financieros, 2. Corporativos.'
    )
    expect(email.text).not.toContain('room_')
    expect(email.text).not.toContain('teaser')
    expect(email.text).not.toContain('financials')
    expect(email.text).not.toContain('General')
  })

  it('una carpeta desconocida se muestra como Corporativos y no imprime la llave', async () => {
    const { buildTeamAlertEmail } = await import('../../../convex/_helpers/teamEmailTemplates')

    const email = buildTeamAlertEmail({ ...base, folders: ['room_future_folder'] })

    expect(email.text).toContain('Apple Inc. Demo subió 1 documento nuevo en 2. Corporativos.')
    expect(email.text).not.toContain('room_')
  })

  // Convex no importa la taxonomía del cliente, así que la tabla del correo es
  // una copia. Este pin la mantiene igual a lo que muestra la sala: llave
  // canónica, alias (teaser, financials) y el respaldo de General.
  it('usa las mismas etiquetas que la sala para cada carpeta', async () => {
    const { roomFolderLabels } = await import('../../../convex/_helpers/teamEmailTemplates')
    const { VDR_SHELL_FOLDER_VALUES, getVdrShellFolderLabel } =
      await import('../../lib/vdr/document-taxonomy')

    for (const folder of [...VDR_SHELL_FOLDER_VALUES, 'teaser', 'financials', 'General']) {
      expect(roomFolderLabels([folder])).toEqual([getVdrShellFolderLabel(folder, 'es')])
    }
  })
})
