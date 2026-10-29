// ============================================================================
// PRIVACY POLICY PAGE
// ============================================================================
// Política de privacidad de la plataforma — Ley 81 de 2019 y Decreto
// Ejecutivo 285 de 2021 (República de Panamá)
// ============================================================================

import type { Metadata } from 'next'
import { Schema } from 'effect'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { getTranslations } from 'next-intl/server'
import { buildLocalizedPageMetadata } from '@/lib/site/brand'
import { Shield, Calendar } from 'lucide-react'

// El mapa `{ es: … }` de una sola llave y el `_locale` que nadie leía eran
// residuo del corte a un solo idioma ([F] 2026-09-03, DECISIONS): no hay
// segundo locale entre el que elegir, así que el documento es uno solo.
const PRIVACY_TITLE = 'Política de Privacidad'
const PRIVACY_UPDATED = 'Última actualización: agosto de 2026'
const PRIVACY_VERSION_NOTICE = 'Versión preliminar sujeta a revisión legal.'

// La forma del documento se declara una vez y el texto se decodifica al
// importar el módulo. Antes el literal entraba por un `as PrivacySection[]`,
// que es una aserción: una llave mal escrita (`bodyy`) pasaba callada y la
// tarjeta salía sin cuerpo. Ahora la llave de más no compila y el campo vacío
// —una lista sin ítems, un párrafo en blanco— revienta al arrancar, que es
// cuando alguien puede arreglarlo, y no en la página legal ya servida.
const NonEmptyTextSchema = Schema.String.pipe(Schema.check(Schema.isNonEmpty()))

const PrivacyListItemSchema = Schema.Struct({
  label: Schema.optionalKey(NonEmptyTextSchema),
  text: NonEmptyTextSchema,
})

const PrivacyTableSchema = Schema.Struct({
  headers: Schema.Tuple([NonEmptyTextSchema, NonEmptyTextSchema]),
  rows: Schema.Array(Schema.Tuple([NonEmptyTextSchema, NonEmptyTextSchema])).pipe(
    Schema.check(Schema.isNonEmpty())
  ),
})

const PrivacySectionSchema = Schema.Struct({
  title: NonEmptyTextSchema,
  intro: Schema.optionalKey(NonEmptyTextSchema),
  list: Schema.optionalKey(
    Schema.Array(PrivacyListItemSchema).pipe(Schema.check(Schema.isNonEmpty()))
  ),
  table: Schema.optionalKey(PrivacyTableSchema),
  body: Schema.optionalKey(
    Schema.Array(NonEmptyTextSchema).pipe(Schema.check(Schema.isNonEmpty()))
  ),
})

const decodePrivacySections = Schema.decodeSync(Schema.Array(PrivacySectionSchema))

const PRIVACY_SECTIONS = decodePrivacySections([
  {
    title: '1. Responsable del tratamiento',
    body: [
      'El operador de esta instalación de Sherlock es responsable del tratamiento de tus datos personales conforme a la Ley 81 de 26 de marzo de 2019 sobre Protección de Datos Personales de la República de Panamá y su reglamentación (Decreto Ejecutivo 285 de 28 de mayo de 2021).',
      'Contacto para asuntos de privacidad: el equipo que opera esta instalación, mediante la sección Ayuda.',
    ],
  },
  {
    title: '2. Datos que recopilamos',
    intro: 'Recopilamos los siguientes datos:',
    list: [
      {
        label: 'Datos de cuenta y contacto:',
        text: 'nombre, correo electrónico, teléfono, país, idioma, credenciales de acceso (gestionadas por nuestro proveedor de autenticación).',
      },
      {
        label: 'Datos de verificación (KYC/KYB):',
        text: 'documento de identidad o pasaporte, fecha de nacimiento, nacionalidad; para empresas: documentos societarios, registro, beneficiarios finales, representantes legales; verificaciones contra listas de sanciones y de prevención de blanqueo de capitales. Esta verificación la realiza nuestro equipo mediante revisión humana — generalmente cuando tu empresa se prepara para compartir materiales con terceros — y parte de ella puede realizarla un proveedor especializado, que se identificará en el aviso aplicable.',
      },
      {
        label: 'Datos financieros y de negocio:',
        text: 'la información financiera y comercial que tu empresa carga a tu espacio de trabajo y sala de datos (estados financieros, métricas, documentos), y los registros de acceso de los invitados a esa sala de datos.',
      },
      {
        label: 'Datos transaccionales de servicios pagados:',
        text: 'si se contrata un servicio pagado, el servicio seleccionado y el historial de facturación. No almacenamos números completos de tarjeta; cualquier pago habilitado lo procesa el proveedor identificado en los términos de facturación aplicables.',
      },
      {
        label: 'Datos técnicos y de uso:',
        text: 'dirección IP, tipo de dispositivo y navegador, páginas visitadas, acciones dentro de la Plataforma, registros de acceso a documentos (bitácora de la sala de datos), cookies e identificadores similares (ver sección 8).',
      },
      {
        label: 'Comunicaciones:',
        text: 'mensajes intercambiados dentro de la Plataforma y correspondencia con nuestro equipo.',
      },
    ],
  },
  {
    title: '3. Finalidades y base legal',
    table: {
      headers: ['Finalidad', 'Base legal (Ley 81)'],
      rows: [
        [
          'Crear y administrar tu cuenta; prestar los servicios de la Plataforma',
          'Ejecución del contrato (Términos y Condiciones)',
        ],
        [
          'Verificación de identidad y de empresa (KYC/KYB), prevención de fraude y de blanqueo de capitales',
          'Obligación legal / interés legítimo / consentimiento',
        ],
        [
          'Preparación de los materiales de tu empresa y compartición controlada con las contrapartes que autorices (incluyendo herramientas analíticas internas)',
          'Ejecución del contrato',
        ],
        [
          'Si se contratan, facturación y cobro de servicios',
          'Ejecución del contrato / obligación legal',
        ],
        [
          'Registro y auditoría de accesos a documentos confidenciales (VDR)',
          'Ejecución del contrato / interés legítimo',
        ],
        ['Seguridad de la Plataforma, prevención de abuso', 'Interés legítimo'],
        ['Analítica de producto y mejora del servicio', 'Consentimiento / interés legítimo'],
        [
          'Comunicaciones operativas (avisos de cuenta, cambios de términos)',
          'Ejecución del contrato',
        ],
        ['Comunicaciones comerciales propias', 'Consentimiento (revocable en cualquier momento)'],
        ['Cumplimiento de requerimientos de autoridades', 'Obligación legal'],
      ],
    },
    body: [
      'No tomamos decisiones automatizadas con efectos jurídicos sobre ti sin intervención humana: las aprobaciones de publicación, compartición y verificación siempre pasan por revisión de nuestro equipo.',
    ],
  },
  {
    title: '4. Encargados y transferencias',
    intro: 'Compartimos datos únicamente con:',
    list: [
      {
        label: 'Proveedores tecnológicos (encargados del tratamiento):',
        text: 'autenticación e identidad (WorkOS), base de datos y backend (Convex), alojamiento web (Vercel) y analítica de producto y monitoreo de errores (PostHog). El procesamiento de pagos (por ejemplo, Lemon Squeezy) y los proveedores de verificación KYC/KYB se usan solo si se habilitan para una oferta o flujo de verificación específico, y se identificarán en el aviso o los términos de facturación aplicables. Estos proveedores tratan los datos por cuenta nuestra, bajo contrato y solo para las finalidades indicadas.',
      },
      {
        label: 'Invitados que tú autorizas, de forma controlada:',
        text: 'los documentos confidenciales y la información de la empresa solo se revelan a las contrapartes concretas que tú decides invitar a tu sala de datos, tras la revisión de nuestro equipo y, cuando corresponde, la firma del acuerdo de confidencialidad (NDA) y la verificación de acceso del invitado.',
      },
      {
        label: 'Autoridades competentes,',
        text: 'cuando exista obligación legal.',
      },
    ],
    body: [
      'No vendemos datos personales a terceros.',
      'Transferencias internacionales: varios de nuestros proveedores alojan datos fuera de Panamá (principalmente en los Estados Unidos y la Unión Europea). Estas transferencias se amparan en las bases previstas por la Ley 81: la ejecución del contrato contigo, tu consentimiento al aceptar esta Política y, cuando corresponde, cláusulas contractuales con los encargados que garantizan un nivel de protección equivalente al de la Ley 81 (incluyendo las cláusulas contractuales tipo de la Red Iberoamericana de Protección de Datos, adoptadas por la ANTAI mediante Resolución ANTAI-DG-003-2026).',
    ],
  },
  {
    title: '5. Plazos de conservación',
    list: [
      {
        text: 'Datos de cuenta y perfil: mientras la cuenta esté activa y hasta 12 meses después de su cierre.',
      },
      {
        text: 'Datos KYC/KYB y de prevención de blanqueo: 5 años desde la terminación de la relación, conforme a las normas aplicables.',
      },
      {
        text: 'Si se habilita la facturación, los registros se conservan por los plazos exigidos por la legislación fiscal panameña.',
      },
      {
        text: 'Bitácoras de acceso a documentos (VDR) y registros de seguridad: 5 años, por su función probatoria.',
      },
      {
        text: 'Datos analíticos: agregados o seudonimizados cuando dejen de ser necesarios en forma identificable.',
      },
    ],
    body: ['Vencidos los plazos, los datos se eliminan o anonimizan de forma segura.'],
  },
  {
    title: '6. Tus derechos (ARCO + portabilidad)',
    body: [
      'Conforme a la Ley 81, puedes ejercer los derechos de acceso, rectificación, cancelación, oposición y portabilidad sobre tus datos personales, contactando al equipo desde la sección Ayuda de tu cuenta, o mediante las opciones de la propia Plataforma (incluyendo la solicitud de eliminación de cuenta desde la configuración).',
      'Atenderemos tu solicitud de forma gratuita en los plazos legales: acceso dentro de diez (10) días hábiles (art. 16, Ley 81) y rectificación dentro de cinco (5) días hábiles (art. 17, Ley 81). La cancelación no procederá sobre los datos que estemos legalmente obligados a conservar (sección 5), lo que te será informado.',
      'Si consideras que tus derechos no fueron atendidos, puedes acudir a la Autoridad Nacional de Transparencia y Acceso a la Información (ANTAI), autoridad de protección de datos de la República de Panamá.',
    ],
  },
  {
    title: '7. Seguridad',
    body: [
      'Aplicamos medidas técnicas y organizativas apropiadas: cifrado en tránsito, control de acceso por roles, registro de accesos a documentos confidenciales, segregación de ambientes, monitoreo de seguridad y evaluación de proveedores, y mantenemos el registro de bases de datos (ficha técnica) exigido por la normativa. Ningún sistema es infalible; en caso de una violación de seguridad que represente un riesgo para tus datos, te la notificaremos a ti y a la ANTAI lo más pronto posible y a más tardar dentro de las 72 horas siguientes a tener conocimiento de ella (art. 37 del Decreto Ejecutivo 285 de 2021), indicando la naturaleza del incidente, los datos comprometidos, las medidas adoptadas y nuestras recomendaciones.',
    ],
  },
  {
    title: '8. Cookies y tecnologías similares',
    intro: 'Usamos:',
    list: [
      {
        label: 'Cookies esenciales —',
        text: 'sesión, autenticación y seguridad. Necesarias; sin ellas la Plataforma no funciona.',
      },
      {
        label: 'Herramienta de analítica sin cookies (PostHog, proxy propio) —',
        text: 'para entender el uso del producto, reproducir problemas de navegación y mejorarlo. Guarda identificadores técnicos en localStorage, sin cookies analíticas ni perfiles personales de PostHog. Se registran páginas, acciones, rendimiento, errores y reproducciones de la interfaz con campos y contenido documental ocultos.',
      },
    ],
    body: [
      'No usamos cookies de publicidad de terceros ni mostramos un banner de cookies analíticas. La medición incluye el uso de las salas de datos. Las credenciales, los campos de formulario, los archivos y los parámetros privados de las URLs se ocultan antes de enviarse a PostHog. Respetamos Do Not Track y Global Privacy Control: estas señales deshabilitan la captura analítica sin afectar el servicio.',
    ],
  },
  {
    title: '9. Menores',
    body: [
      'La Plataforma no está dirigida a menores de 18 años y no recopilamos deliberadamente sus datos. Si detectamos una cuenta de un menor, la eliminaremos.',
    ],
  },
  {
    title: '10. Cambios a esta Política',
    body: [
      'Publicaremos las modificaciones en esta página y, si son materiales, las notificaremos por correo o aviso en la Plataforma con antelación razonable. La fecha de versión aparece en el encabezado.',
    ],
  },
  {
    title: '11. Ley aplicable',
    body: [
      'Esta Política se rige por las leyes de la República de Panamá. Cualquier controversia se resolverá conforme a la cláusula de ley aplicable y jurisdicción de los Términos y Condiciones.',
    ],
  },
])

// ===== SEO METADATA =====
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const [t, siteMeta] = await Promise.all([
    getTranslations({ locale, namespace: 'privacy.meta' }),
    getTranslations({ locale, namespace: 'site.meta' }),
  ])

  return buildLocalizedPageMetadata({
    locale,
    path: '/privacy',
    title: t('title'),
    description: t('description'),
    imageAlt: siteMeta('imageAlt'),
  })
}

export default async function PrivacyPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      {/* ===== HEADER ===== */}
      <div className="mb-6 max-w-3xl">
        <div className="mb-2 flex items-center gap-3">
          <Shield className="text-primary h-5 w-5 shrink-0" />
          <h1 className="text-2xl font-normal tracking-tight">{PRIVACY_TITLE}</h1>
        </div>
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Calendar className="h-4 w-4" />
          {PRIVACY_UPDATED}
        </div>
        <p className="text-muted-foreground mt-2 text-sm italic">{PRIVACY_VERSION_NOTICE}</p>
      </div>

      {/* ===== CONTENT ===== */}
      <div className="prose prose-sherlock max-w-2xl">
        {PRIVACY_SECTIONS.map((section) => (
          <Card
            key={section.title}
            className="mb-8 gap-2 rounded-none border-0 bg-transparent py-0 shadow-none"
          >
            <CardHeader className="grid-rows-[auto] gap-0 px-0">
              {/* Titulo de seccion real, no un parrafo con aspecto de titulo: dentro
                  de `main` solo existia el h1 y los once numerales del documento no
                  se podian saltar con lector de pantalla. Las clases repiten lo que
                  daba `CardTitle` (16px, sans, semibold) y ganan por `!` a la regla
                  `.prose-sherlock :is(h1, h2, ...)` de `globals.css`, que si no
                  pintaria el titulo en Fraunces borgona. El texto legal no cambia. */}
              <h2
                data-slot="card-title"
                className="text-card-foreground! font-sans! text-base leading-snug font-semibold tracking-normal"
              >
                {section.title}
              </h2>
            </CardHeader>
            <CardContent className="text-foreground space-y-3 px-0 text-base leading-relaxed">
              {section.intro && <p>{section.intro}</p>}
              {section.list && (
                <ul className="list-disc space-y-2 pl-6">
                  {section.list.map((item) => (
                    <li key={item.label ?? item.text}>
                      {item.label && <strong>{item.label} </strong>}
                      {item.text}
                    </li>
                  ))}
                </ul>
              )}
              {section.table && (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr>
                        {section.table.headers.map((header) => (
                          <th
                            key={header}
                            className="border-border text-foreground border-b px-3 py-2 text-left font-semibold"
                          >
                            {header}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {section.table.rows.map((row) => (
                        <tr key={row[0]}>
                          {row.map((cell, cellIndex) => (
                            <td
                              key={cellIndex === 0 ? cell : `${row[0]}-${cell}`}
                              className="border-border border-b px-3 py-2 align-top"
                            >
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {section.body?.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
