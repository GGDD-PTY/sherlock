// ============================================================================
// TERMS OF SERVICE PAGE
// ============================================================================
// Términos y condiciones del servicio
// Public scope: company-first sell-side preparation with controlled sharing.
// ============================================================================

import type { Metadata } from 'next'
import { Schema } from 'effect'
import { getTranslations } from 'next-intl/server'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { buildLocalizedPageMetadata } from '@/lib/site/brand'
import { FileText, Calendar } from 'lucide-react'

// Los mapas `{ es: … }` de una sola llave y el `_locale` que nadie leía eran
// residuo del corte a un solo idioma ([F] 2026-09-03, DECISIONS): no hay
// segundo locale entre el que elegir, así que el documento es uno solo.
const TERMS_TITLE = 'Términos y Condiciones'
const TERMS_IMAGE_ALT = 'Términos de preparación sell-side de Sherlock'
const TERMS_UPDATED = 'Última actualización: agosto de 2026'
const TERMS_VERSION_NOTICE = 'Versión preliminar sujeta a revisión legal.'

// La forma del documento se declara una vez y el texto se decodifica al
// importar el módulo: una sección sin cuerpo, un párrafo en blanco o una llave
// mal escrita revientan al arrancar en vez de servirse como una tarjeta vacía
// dentro de un contrato.
const NonEmptyTextSchema = Schema.String.pipe(Schema.check(Schema.isNonEmpty()))

const TermsSectionSchema = Schema.Struct({
  title: NonEmptyTextSchema,
  body: Schema.Array(NonEmptyTextSchema).pipe(Schema.check(Schema.isNonEmpty())),
})

const decodeTermsSections = Schema.decodeSync(Schema.Array(TermsSectionSchema))

const TERMS_SECTIONS = decodeTermsSections([
  {
    title: '1. Identificación del operador',
    body: [
      'Esta instalación de Sherlock (la "Plataforma") es operada bajo el nombre Sherlock por su operador vigente (el "Operador", "nosotros"). La identidad legal y jurisdicción del Operador se identificarán en el aviso contractual aplicable antes de cualquier registro o servicio pagado.',
      'Contacto: el equipo que opera esta instalación, mediante la sección Ayuda.',
    ],
  },
  {
    title: '2. Aceptación',
    body: [
      'Al registrarte, acceder o usar la Plataforma, tú (el "Usuario") aceptas estos Términos y Condiciones (los "Términos"), la Política de Privacidad y los Avisos y Descargos de Responsabilidad, que forman parte integral de este contrato. Si no estás de acuerdo, no uses la Plataforma.',
      'El Operador puede modificar estos Términos; los cambios materiales se notificarán con al menos 15 días calendario de anticipación por correo electrónico o aviso en la Plataforma. El uso continuado tras la entrada en vigor constituye aceptación.',
    ],
  },
  {
    title: '3. Naturaleza de la Plataforma — qué es y qué NO es',
    body: [
      'Sherlock es un servicio de preparación sell-side centrado en empresas. Las empresas contratan al equipo para organizar sus fuentes y preparar entregables transaccionales como modelos financieros, teasers, CIMs, management presentations y decks de crédito o equity. El trabajo se mantiene en un workspace privado de empresa y se revisa con humanos antes de entregarlo o compartirlo.',
      'Mycroft es un servicio externo hermano sin conexión con esta aplicación. El equipo baja los materiales autorizados a un entorno privado, trabaja ahí y sube a tu Data Room solo los entregables revisados.',
      'El Operador NO:',
      '1. Opera una oferta pública, un catálogo de oportunidades ni un servicio autoservicio de proveedores de capital.',
      '2. Actúa como corredor, bolsa, asesor de inversiones ni proveedor de asesoría financiera, legal, contable, fiscal o de inversión.',
      '3. Audita, certifica ni verifica de forma independiente la información financiera, comercial, legal, contable o fiscal que aporta una empresa.',
      '4. Custodia, recibe, transfiere ni intermedia fondos de una transacción.',
      '5. Garantiza financiamiento, venta, comprador, prestamista, term sheet, cierre, rendimiento ni la exactitud de las fuentes.',
    ],
  },
  {
    title: '4. Workspace y acceso de invitados',
    body: [
      '1. El workspace de empresa sirve para organizar documentos, trabajo de preparación y compartir autorizado. El acceso queda acotado a la empresa y, cuando corresponde, a la transacción o sala aprobada por el equipo.',
      '2. El equipo puede solicitar información de la empresa antes de entregar materiales o emitir acceso de invitado. Esa revisión es manual y tiene un propósito operativo limitado; no es una auditoría, certificación ni opinión sobre el mérito de una transacción.',
      '3. El sitio público no ofrece cuentas autoservicio de proveedores de capital ni un catálogo público de oportunidades. Si un proceso privado avanza, el equipo puede enviar un teaser y emitir una invitación de invitado para una sala específica.',
      '4. El acceso de invitado puede requerir un código de un solo uso y un NDA firmado antes de mostrar materiales confidenciales. El equipo puede pausar o rechazar una solicitud si faltan los pasos relevantes de revisión o confidencialidad.',
    ],
  },
  {
    title: '5. Preparación y entrega',
    body: [
      '1. La empresa proporciona las fuentes y el contexto solicitado para el alcance acordado. La empresa sigue siendo responsable de la exactitud y autorización de lo que entrega.',
      '2. El equipo puede usar Mycroft para procesar las fuentes fuera de esta aplicación, como se describe arriba. El equipo revisa el trabajo y los entregables acordados antes de entregarlos o compartirlos.',
      '3. Los entregables son apoyo para la preparación. No constituyen auditoría, certificación, recomendación ni garantía de financiamiento, venta, compra, cierre o rendimiento.',
      '4. Cualquier transacción, negociación, documentación definitiva y movimiento de fondos ocurre entre las partes relevantes y sus propios asesores. Sherlock no es parte de esos arreglos salvo que un acuerdo escrito separado lo indique expresamente.',
    ],
  },
  {
    title: '6. Servicios, alcance y facturación',
    body: [
      '1. El trabajo de preparación se cotiza según alcance. Los términos de servicio aplicables identifican los entregables, supuestos sobre las fuentes, cronograma, cargos y términos de pago antes de comenzar.',
      '2. Este sitio público no publica una tabla de acceso recurrente ni de cargos transaccionales. No debes pagar nada salvo que los términos de servicio o un acuerdo escrito aplicable lo indiquen.',
      '3. Un cambio en los entregables o en las fuentes puede cambiar el alcance, el cronograma o los cargos. El equipo confirma los términos revisados antes de asumir trabajo adicional.',
      '4. Un cargo de servicio cubre únicamente el trabajo de preparación descrito en el alcance aplicable. No garantiza financiamiento, venta, comprador, prestamista, term sheet, cierre ni rendimiento.',
    ],
  },
  {
    title: '7. Obligaciones y conducta del Usuario',
    body: [
      'El Usuario se obliga a:',
      '1. Usar la Plataforma y el workspace únicamente para los fines de preparación, documentos y acceso descritos en estos Términos y en los términos de servicio aplicables.',
      '2. Mantener seguras tus credenciales y toda información confidencial recibida a través del workspace o de una sala de invitados, conforme a cualquier NDA o término de confidencialidad aplicable.',
      '3. Proporcionar información y documentos que tengas autorización para compartir, y avisar al equipo si detectas errores materiales o cambios relevantes.',
      '4. No compartir, revender, divulgar, extraer masivamente ni usar indebidamente documentos o accesos de workspace de otra parte.',
      '5. No interferir con la seguridad o el funcionamiento de la Plataforma ni usarla para un fin ilícito.',
    ],
  },
  {
    title: '8. Contenido del Usuario y propiedad intelectual',
    body: [
      '1. El Usuario conserva la titularidad de la información y los documentos que carga, sujeto a los derechos y permisos necesarios para prestar el servicio acordado.',
      '2. El Usuario autoriza al Operador y a sus servicios de procesamiento autorizados, incluido Mycroft cuando corresponda, a alojar y procesar los materiales suministrados únicamente para la preparación, revisión, entrega, seguridad y control de acceso solicitados.',
      '3. El Usuario declara que tiene autorización para proporcionar los materiales y solicitar el trabajo acordado. No debes cargar material que no tengas permitido compartir.',
      '4. La Plataforma, su software, marcas (incluyendo "Sherlock"), diseño y contenidos propios son propiedad del Operador o de sus licenciantes. No se otorga al Usuario otra licencia que la necesaria para el servicio acordado.',
    ],
  },
  {
    title: '9. Descargos de responsabilidad',
    body: [
      '1. La Plataforma se provee "tal cual" y "según disponibilidad". El Operador no garantiza disponibilidad ininterrumpida ni ausencia de errores.',
      '2. La revisión humana y el procesamiento de Mycroft no auditan, certifican ni verifican de forma independiente la información financiera, comercial, legal, contable o fiscal que aporta una empresa.',
      '3. Los entregables y cualquier resultado analítico son apoyo para la preparación, no asesoría financiera, legal, contable, fiscal ni de inversión, y no constituyen una recomendación.',
      '4. Toda decisión de financiamiento, venta, compra u otra transacción es responsabilidad exclusiva de las partes que la toman y de sus propios asesores. Sherlock no garantiza una transacción, financiamiento, cierre ni rendimiento.',
    ],
  },
  {
    title: '10. Limitación de responsabilidad',
    body: [
      'En la máxima medida permitida por la ley aplicable:',
      '1. El Operador no responderá por daños indirectos, lucro cesante, pérdida de oportunidad, pérdida de datos ni daños consecuenciales.',
      '2. La responsabilidad total acumulada del Operador frente a un Usuario, por cualquier causa, se limita al monto efectivamente pagado por ese Usuario al Operador en los 12 meses anteriores al hecho que dé lugar al reclamo.',
      '3. Nada en estos Términos limita la responsabilidad que no pueda limitarse conforme a la ley, incluyendo la derivada de dolo o culpa grave.',
    ],
  },
  {
    title: '11. Suspensión y terminación',
    body: [
      '1. El Operador puede pausar o terminar el acceso de un Usuario que incumpla estos Términos, un término de servicio aplicable o un requisito de confidencialidad, con o sin previo aviso según las circunstancias.',
      '2. El Usuario puede dejar de usar la Plataforma y solicitar el cierre de su cuenta mediante el canal de soporte disponible. Las obligaciones de confidencialidad, propiedad intelectual, limitación de responsabilidad y las que por su naturaleza deban sobrevivir continuarán después de la terminación.',
      '3. Tras la terminación, el Operador manejará los datos retenidos según la Política de Privacidad y los términos de servicio aplicables.',
    ],
  },
  {
    title: '12. Ley aplicable y jurisdicción',
    body: [
      'Los términos de servicio aplicables u otro acuerdo escrito identifican la ley aplicable y la resolución de controversias para el trabajo solicitado. Si un acuerdo específico contiene términos que contradicen estos Términos, el acuerdo específico controla el trabajo que cubre.',
      'Nada en estos Términos limita derechos o protecciones que no puedan limitarse conforme a la ley aplicable.',
    ],
  },
  {
    title: '13. Disposiciones finales',
    body: [
      '1. Idioma: estos Términos están disponibles en español. Si un acuerdo de servicio o confidencialidad firmado difiere de este texto, prevalece ese acuerdo.',
      '2. Nulidad parcial: la invalidez de una cláusula no afecta al resto.',
      '3. Acuerdo íntegro: estos Términos, junto con la Política de Privacidad, los Avisos y Descargos y cualquier acuerdo de servicio o confidencialidad aplicable, describen el acuerdo para usar la Plataforma y el workspace.',
      '4. Notificaciones: al correo electrónico registrado del Usuario y, para el Operador, mediante la sección Ayuda de esta instalación.',
    ],
  },
])

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await getTranslations({ locale, namespace: 'terms.meta' })

  return buildLocalizedPageMetadata({
    locale,
    path: '/terms',
    title: t('title'),
    description: t('description'),
    imageAlt: TERMS_IMAGE_ALT,
  })
}

export default async function TermsPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      {/* ===== HEADER ===== */}
      <div className="mb-6 max-w-3xl">
        <div className="mb-2 flex items-center gap-3">
          <FileText className="text-primary h-5 w-5 shrink-0" />
          <h1 className="text-2xl font-normal tracking-tight">{TERMS_TITLE}</h1>
        </div>
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Calendar className="h-4 w-4" />
          {TERMS_UPDATED}
        </div>
        <p className="text-muted-foreground mt-1 text-sm italic">{TERMS_VERSION_NOTICE}</p>
      </div>

      {/* ===== CONTENT ===== */}
      <div className="prose prose-sherlock max-w-2xl">
        {TERMS_SECTIONS.map((section) => (
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
              {section.body.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
