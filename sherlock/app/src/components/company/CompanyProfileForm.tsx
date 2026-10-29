'use client'

// ============================================================================
// TU EMPRESA — el perfil vive en la sala, debajo de los documentos
// ============================================================================
// [F] 2026-09-07 09:00: la información de la empresa se edita en el Data Room
// con campos planos y un solo «Guardar»: solo lo que el equipo usa en el
// teaser, el CIM y el modelo. [F] 2026-09-13: el formulario cliente conserva
// identidad, descripción, equipo y contacto. Los términos financieros guardados
// se mantienen fuera de este formulario.
//
// Es una pantalla entera (docs/design-system-vdr.md): h2 en Fraunces, grupos
// como <fieldset> sin hairlines entre ellos, y el único Guardar en un pie fijo
// que se ve sin scroll. El contacto (email de la cuenta, teléfono) entra como
// último grupo y se guarda con el mismo botón. La única tarjeta es cada persona
// del equipo, que sí es un objeto acotado.

import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useMutation } from 'convex/react'
import { useTranslations } from 'next-intl'
import { Effect, Exit, Option, Schema, SchemaIssue } from 'effect'

import { api } from '@/../convex/_generated/api'
import type { Id } from '@/../convex/_generated/dataModel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { trackRoomJourney } from '@/lib/analytics/room-journey'
import type { CompanyProfileValues, TeamMember } from '@/lib/company/profile-values'
import { COUNTRIES } from '@/lib/constants/countries'
import { runClientEffectExit, runClientSyncExit } from '@/lib/effect/client-runtime'
import { normalizeSubmittedPhone, saveContactPhone } from './contactPhone'
import { cn } from '@/lib/utils'

const MIN_FOUNDED_YEAR = 1900

type TeamRow = TeamMember & { key: number }

type FormState = {
  name: string
  legalName: string
  country: string
  city: string
  website: string
  foundedYear: string
  employees: string
  sector: string
  industry: string
  tagline: string
  description: string
  team: TeamRow[]
}

type FieldKey = Exclude<keyof FormState, 'team'>
type TeamFieldKey = 'name' | 'title'
type Errors = Partial<Record<FieldKey, string>> & {
  team?: Record<number, Partial<Record<TeamFieldKey, string>>>
}

function toFormState(values: CompanyProfileValues): FormState {
  return {
    name: values.name,
    legalName: values.legalName,
    country: values.country,
    city: values.city,
    website: values.website,
    foundedYear: values.foundedYear === null ? '' : String(values.foundedYear),
    employees: values.employees,
    sector: values.sector,
    industry: values.industry,
    tagline: values.tagline,
    description: values.description,
    team: values.managementTeam.map((member, index) => ({ ...member, key: index })),
  }
}

function isBlankMember(member: TeamMember): boolean {
  return (
    !member.name.trim() && !member.title.trim() && !member.bio?.trim() && !member.linkedin?.trim()
  )
}

// Una fila vacía se descarta sin ruido; una a medias exige nombre y cargo.
function cleanTeam(team: readonly TeamMember[]): TeamMember[] {
  return team
    .filter((member) => !isBlankMember(member))
    .map((member) => ({
      name: member.name.trim(),
      title: member.title.trim(),
      ...(member.bio?.trim() ? { bio: member.bio.trim() } : {}),
      ...(member.linkedin?.trim() ? { linkedin: member.linkedin.trim() } : {}),
    }))
}

function hasErrors(errors: Errors): boolean {
  const { team, ...fields } = errors
  if (Object.values(fields).some(Boolean)) return true
  return Object.values(team ?? {}).some((member) => Object.values(member).some(Boolean))
}

type Translate = (key: string, values?: Record<string, string | number>) => string

// ============================================================================
// LA COSTURA CON EFFECT
// ============================================================================
// Las reglas del formulario estaban escritas como una escalera de `if` que
// mezclaba dos cosas: qué hace válido a un campo, y qué mensaje se pinta. Ahora
// la regla vive en un `effect/Schema`: el año es un entero entre 1900 y hoy.
// El componente sigue siendo
// el único dueño del texto, que sale de `next-intl` como siempre.
//
// `errors: 'all'` no es opcional. Effect por defecto para en el primer campo
// malo, y un formulario que marca uno por intento hace que
// el cliente descubra sus errores de a uno. Con `all`, un submit marca todo lo
// que está mal, que es lo que este formulario ya hacía y no puede perder.
//
// Un campo vacío que no es obligatorio entra como `null` y el `NullOr` lo deja
// pasar; un campo escrito que no se puede leer como número entra como `NaN`,
// que no es entero ni es mayor que cero, así que falla por donde debe.

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1()

/** Un segmento de path puede venir crudo o envuelto en `{ key }`. */
function segmentKey(segment: PropertyKey | { readonly key: PropertyKey }): PropertyKey {
  return typeof segment === 'object' && segment !== null && 'key' in segment ? segment.key : segment
}

/** Los campos del primer nivel que fallaron. Vacío si el objeto entero pasó. */
function invalidFields<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown
): Set<string> {
  const exit = Schema.decodeUnknownExit(schema, { errors: 'all' })(input)
  if (Exit.isSuccess(exit)) return new Set()

  const failure = Exit.findErrorOption(exit)
  if (Option.isNone(failure)) return new Set()

  const fields = new Set<string>()
  for (const problem of formatIssue(failure.value.issue).issues) {
    const [segment] = problem.path ?? []
    if (segment !== undefined) fields.add(String(segmentKey(segment)))
  }
  return fields
}

const RequiredText = Schema.String.pipe(Schema.check(Schema.isMinLength(1)))

/** El año fundacional es opcional, dentro del rango permitido. */
function profileFieldsSchema(currentYear: number) {
  return Schema.Struct({
    name: RequiredText,
    country: RequiredText,
    foundedYear: Schema.NullOr(
      Schema.Number.pipe(
        Schema.check(
          Schema.isInt(),
          Schema.isBetween({ minimum: MIN_FOUNDED_YEAR, maximum: currentYear })
        )
      )
    ),
  })
}

// Cada persona del equipo se valida por separado para conservar SU índice: la
// lista se recorre entera, las filas en blanco se descartan sin ruido, y las
// que quedan a medias exigen nombre y cargo.
const TeamMemberSchema = Schema.Struct({ name: RequiredText, title: RequiredText })

function validate(state: FormState, t: Translate): Errors {
  const errors: Errors = {}
  const currentYear = new Date().getFullYear()

  const invalid = invalidFields(profileFieldsSchema(currentYear), {
    name: state.name.trim(),
    country: state.country,
    foundedYear: state.foundedYear.trim() ? Number(state.foundedYear.trim()) : null,
  })

  if (invalid.has('name')) errors.name = t('errors.name')
  if (invalid.has('country')) errors.country = t('errors.country')
  if (invalid.has('foundedYear'))
    errors.foundedYear = t('errors.foundedYear', { year: currentYear })

  state.team.forEach((member, index) => {
    if (isBlankMember(member)) return
    const invalidMember = invalidFields(TeamMemberSchema, {
      name: member.name.trim(),
      title: member.title.trim(),
    })
    const memberErrors: Partial<Record<TeamFieldKey, string>> = {}
    if (invalidMember.has('name')) memberErrors.name = t('errors.memberName')
    if (invalidMember.has('title')) memberErrors.title = t('errors.memberTitle')
    if (Object.keys(memberErrors).length > 0) {
      errors.team = { ...errors.team, [index]: memberErrors }
    }
  })

  return errors
}

function firstInvalidFieldId(errors: Errors, ids: FieldIds): string | null {
  const { team, ...fields } = errors
  for (const key of Object.keys(ids.fields) as FieldKey[]) {
    if (fields[key]) return ids.fields[key]
  }
  for (const [index, memberErrors] of Object.entries(team ?? {})) {
    if (memberErrors.name) return ids.member(Number(index), 'name')
    if (memberErrors.title) return ids.member(Number(index), 'title')
  }
  return null
}

type FieldIds = {
  fields: Record<FieldKey, string>
  member: (index: number, field: 'name' | 'title' | 'bio' | 'linkedin') => string
}

function buildFieldIds(prefix: string): FieldIds {
  const keys: FieldKey[] = [
    'name',
    'legalName',
    'country',
    'city',
    'website',
    'foundedYear',
    'employees',
    'sector',
    'industry',
    'tagline',
    'description',
  ]
  return {
    fields: Object.fromEntries(keys.map((key) => [key, `${prefix}-${key}`])) as Record<
      FieldKey,
      string
    >,
    member: (index, field) => `${prefix}-team-${index}-${field}`,
  }
}

class CompanyProfileSaveFailed extends Schema.TaggedError<CompanyProfileSaveFailed>()(
  'CompanyProfileSaveFailed',
  { cause: Schema.Defect() }
) {}

/**
 * El guardado del perfil. Vive fuera del componente y recibe la mutation por
 * argumento: definido adentro sería una función nueva por render.
 */
const saveCompanyProfile = Effect.fn('CompanyProfile.save')(function* <A>(
  updateCompany: (args: A) => Promise<unknown>,
  args: A
): Effect.fn.Return<void, CompanyProfileSaveFailed> {
  yield* Effect.tryPromise({
    try: () => updateCompany(args),
    catch: (cause) => new CompanyProfileSaveFailed({ cause }),
  }).pipe(
    Effect.tapError((error) =>
      Effect.logError('[CompanyProfileForm] No se pudo guardar el perfil:', error.cause)
    )
  )
})

type ControlProps = {
  id: string
  'aria-invalid': boolean | undefined
  'aria-describedby': string | undefined
}

// Etiqueta, pista y error asociados por id al control (label → htmlFor,
// control → aria-describedby / aria-invalid). El control se pinta por render
// prop para que un Select reciba los mismos atributos que un Input.
function Field({
  id,
  label,
  required = false,
  requiredLabel,
  hint,
  error,
  className,
  children,
}: {
  id: string
  label: string
  required?: boolean
  requiredLabel: string
  hint?: string
  error?: string
  className?: string
  children: (control: ControlProps) => ReactNode
}) {
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined

  return (
    <div className={cn('space-y-2', className)}>
      <Label htmlFor={id}>
        {label}
        {required ? (
          <>
            <span aria-hidden="true">*</span>
            <span className="sr-only">({requiredLabel})</span>
          </>
        ) : null}
      </Label>
      {hint ? (
        <p id={hintId} className="text-muted-foreground text-xs">
          {hint}
        </p>
      ) : null}
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy })}
      {error ? (
        <p id={errorId} role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function CompanyProfileForm({
  companyId,
  initial,
  isDemo = false,
  withContact = false,
  className,
}: {
  companyId: Id<'companies'>
  initial: CompanyProfileValues
  /** La sala de ejemplo de dev-auth no tiene fila en Convex: nada se guarda. */
  isDemo?: boolean
  /** El grupo «Contacto» (email de la cuenta y teléfono). El equipo, desde /admin, no lo ve. */
  withContact?: boolean
  className?: string
}) {
  const t = useTranslations('companyProfile')
  const contactT = useTranslations('roomWorkspace.contact')
  const { toast } = useToast()
  const { user, profile, isLoading: contactLoading } = useCurrentUser()
  const savePhone = useMutation(api.companies.updateContactPhone)
  const savedPhone =
    profile && 'phone' in profile && typeof profile.phone === 'string' ? profile.phone : ''
  // `null` significa que la persona todavía no tocó el teléfono: así el número
  // que llega con la query aparece sin sincronizar props mediante un efecto.
  const [phone, setPhone] = useState<string | null>(null)
  const [phoneError, setPhoneError] = useState<'invalid' | 'save' | null>(null)
  const phoneValue = phone ?? savedPhone
  const phoneId = `${useId()}company-profile-phone`
  const phoneRef = useRef<HTMLInputElement>(null)
  const prefix = useId()
  const ids = buildFieldIds(`${prefix}company-profile`)
  const headingId = `${prefix}company-profile-heading`
  const updateCompany = useMutation(api.companies.updateCompany)

  const [state, setState] = useState<FormState>(() => toFormState(initial))
  const [nextTeamKey, setNextTeamKey] = useState(() => initial.managementTeam.length)
  // Línea base del equipo ya guardado: la segunda mutation solo corre cuando
  // la lista cambió, no en cada guardado del resto de los campos.
  const [savedTeam, setSavedTeam] = useState<TeamMember[]>(() => cleanTeam(initial.managementTeam))
  const [errors, setErrors] = useState<Errors>({})
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)

  const set = <K extends FieldKey>(key: K, value: FormState[K]) => {
    setState((current) => ({ ...current, [key]: value }))
    setErrors((current) => (current[key] ? { ...current, [key]: undefined } : current))
  }

  const setMember = (index: number, field: keyof TeamMember, value: string) => {
    setState((current) => ({
      ...current,
      team: current.team.map((member, position) =>
        position === index ? { ...member, [field]: value } : member
      ),
    }))
    setErrors((current) =>
      current.team?.[index]
        ? {
            ...current,
            team: { ...current.team, [index]: { ...current.team[index], [field]: undefined } },
          }
        : current
    )
  }

  const addMember = () => {
    setState((current) => ({
      ...current,
      team: [...current.team, { key: nextTeamKey, name: '', title: '' }],
    }))
    setNextTeamKey((key) => key + 1)
  }

  const removeMember = (index: number) => {
    setState((current) => ({
      ...current,
      team: current.team.filter((_, position) => position !== index),
    }))
    setErrors((current) => (current.team ? { ...current, team: undefined } : current))
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return

    const nextErrors = validate(state, t)
    setErrors(nextErrors)
    if (hasErrors(nextErrors)) {
      const focusId = firstInvalidFieldId(nextErrors, ids)
      if (focusId) document.getElementById(focusId)?.focus()
      return
    }

    // El teléfono se valida antes de guardar nada: un número que no sirve lo
    // arregla el cliente, y no debería costarle un guardado a medias.
    const phoneChanged = withContact && phone !== null && phone.trim() !== savedPhone
    let nextPhone: string | null = null
    if (phoneChanged) {
      const normalized = runClientSyncExit(normalizeSubmittedPhone(phoneValue))
      if (!Exit.isSuccess(normalized)) {
        setPhoneError('invalid')
        phoneRef.current?.focus()
        return
      }
      nextPhone = normalized.value
    }

    if (isDemo) {
      toast({ title: t('demo') })
      return
    }

    const team = cleanTeam(state.team)
    const teamChanged = JSON.stringify(team) !== JSON.stringify(savedTeam)

    setSaving(true)
    setSaveFailed(false)
    setPhoneError(null)
    const exit = await runClientEffectExit(
      saveCompanyProfile(updateCompany, {
        companyId,
        name: state.name.trim(),
        managementTeam: teamChanged ? team : undefined,
        legalName: state.legalName.trim(),
        country: state.country,
        city: state.city.trim(),
        website: state.website.trim(),
        foundedYear: state.foundedYear.trim() ? Number(state.foundedYear.trim()) : null,
        employees: state.employees.trim(),
        sector: state.sector,
        industry: state.industry,
        tagline: state.tagline.trim(),
        description: state.description.trim(),
      })
    )
    if (!Exit.isSuccess(exit)) {
      setSaving(false)
      setSaveFailed(true)
      return
    }

    if (teamChanged) setSavedTeam(team)
    void trackRoomJourney('company_profile_saved', {})

    // Dos mutations, un botón: si el teléfono no pasa, el perfil ya quedó y el
    // pie lo dice por separado.
    if (nextPhone !== null) {
      const phoneExit = await runClientEffectExit(
        saveContactPhone(savePhone, { companyId, phone: nextPhone })
      )
      setSaving(false)
      if (!Exit.isSuccess(phoneExit)) {
        setPhoneError('save')
        return
      }
      setPhone(nextPhone)
      void trackRoomJourney('contact_saved', {})
    } else {
      setSaving(false)
    }
    toast({ title: t('saved') })
  }

  const requiredLabel = t('required')
  const field = (key: FieldKey, options: { required?: boolean; hint?: string } = {}) => ({
    id: ids.fields[key],
    label: t(`fields.${key}`),
    required: options.required,
    requiredLabel,
    hint: options.hint,
    error: errors[key],
  })

  return (
    <section
      id="company-profile"
      className={cn('scroll-mt-24', className)}
      aria-labelledby={headingId}
      data-testid="company-profile-form"
    >
      <h2 id={headingId}>{t('title')}</h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">{t('subtitle')}</p>
      <p className="text-muted-foreground mt-1 text-xs">{t('requiredNote')}</p>

      <form
        className="mt-4 space-y-6"
        noValidate
        aria-busy={saving}
        onSubmit={(...args) => void handleSubmit(...args)}
      >
        <fieldset className="min-w-0 space-y-4">
          <legend className="text-foreground text-base font-semibold">
            {t('groups.identity')}
          </legend>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field {...field('name', { required: true })}>
              {(control) => (
                <Input
                  {...control}
                  value={state.name}
                  autoComplete="organization"
                  maxLength={200}
                  onChange={(event) => set('name', event.target.value)}
                />
              )}
            </Field>
            <Field {...field('legalName')}>
              {(control) => (
                <Input
                  {...control}
                  value={state.legalName}
                  maxLength={200}
                  onChange={(event) => set('legalName', event.target.value)}
                />
              )}
            </Field>
            <Field {...field('country', { required: true })}>
              {(control) => (
                <Select value={state.country} onValueChange={(value) => set('country', value)}>
                  <SelectTrigger {...control}>
                    <SelectValue placeholder={t('placeholders.country')} />
                  </SelectTrigger>
                  <SelectContent>
                    {COUNTRIES.map((country) => (
                      <SelectItem key={country.value} value={country.value}>
                        {country.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
            <Field {...field('city')}>
              {(control) => (
                <Input
                  {...control}
                  value={state.city}
                  autoComplete="address-level2"
                  maxLength={120}
                  onChange={(event) => set('city', event.target.value)}
                />
              )}
            </Field>
            <Field {...field('website')}>
              {(control) => (
                <Input
                  {...control}
                  type="url"
                  inputMode="url"
                  value={state.website}
                  autoComplete="url"
                  maxLength={300}
                  onChange={(event) => set('website', event.target.value)}
                />
              )}
            </Field>
            <Field {...field('foundedYear')}>
              {(control) => (
                <Input
                  {...control}
                  inputMode="numeric"
                  value={state.foundedYear}
                  maxLength={4}
                  onChange={(event) => set('foundedYear', event.target.value.replace(/\D/g, ''))}
                />
              )}
            </Field>
            <Field {...field('employees', { hint: t('hints.employees') })}>
              {(control) => (
                <Input
                  {...control}
                  value={state.employees}
                  maxLength={40}
                  onChange={(event) => set('employees', event.target.value)}
                />
              )}
            </Field>
            <Field {...field('sector')}>
              {(control) => (
                <Input
                  {...control}
                  value={state.sector}
                  maxLength={80}
                  onChange={(event) => set('sector', event.target.value)}
                />
              )}
            </Field>
            <Field {...field('industry')}>
              {(control) => (
                <Input
                  {...control}
                  value={state.industry}
                  maxLength={80}
                  onChange={(event) => set('industry', event.target.value)}
                />
              )}
            </Field>
          </div>
        </fieldset>

        <fieldset className="min-w-0 space-y-4">
          <legend className="text-foreground text-base font-semibold">
            {t('groups.description')}
          </legend>
          <Field {...field('tagline', { hint: t('hints.tagline') })}>
            {(control) => (
              <Input
                {...control}
                value={state.tagline}
                maxLength={160}
                onChange={(event) => set('tagline', event.target.value)}
              />
            )}
          </Field>
          <Field {...field('description', { hint: t('hints.description') })}>
            {(control) => (
              <Textarea
                {...control}
                value={state.description}
                rows={5}
                maxLength={4000}
                onChange={(event) => set('description', event.target.value)}
              />
            )}
          </Field>
        </fieldset>

        <fieldset className="min-w-0 space-y-4">
          <legend className="text-foreground text-base font-semibold">{t('groups.team')}</legend>
          <p className="text-muted-foreground text-sm">{t('team.hint')}</p>
          {state.team.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('team.empty')}</p>
          ) : (
            <ul className="space-y-4">
              {state.team.map((member, index) => {
                const memberErrors = errors.team?.[index]
                return (
                  <li
                    key={member.key}
                    className="border-border rounded-md border p-4"
                    aria-label={t('team.member', { index: index + 1 })}
                  >
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field
                        id={ids.member(index, 'name')}
                        label={t('fields.memberName')}
                        required
                        requiredLabel={requiredLabel}
                        error={memberErrors?.name}
                      >
                        {(control) => (
                          <Input
                            {...control}
                            value={member.name}
                            maxLength={120}
                            onChange={(event) => setMember(index, 'name', event.target.value)}
                          />
                        )}
                      </Field>
                      <Field
                        id={ids.member(index, 'title')}
                        label={t('fields.memberTitle')}
                        required
                        requiredLabel={requiredLabel}
                        error={memberErrors?.title}
                      >
                        {(control) => (
                          <Input
                            {...control}
                            value={member.title}
                            maxLength={120}
                            onChange={(event) => setMember(index, 'title', event.target.value)}
                          />
                        )}
                      </Field>
                      <Field
                        id={ids.member(index, 'linkedin')}
                        label={t('fields.memberLinkedin')}
                        requiredLabel={requiredLabel}
                      >
                        {(control) => (
                          <Input
                            {...control}
                            type="url"
                            inputMode="url"
                            value={member.linkedin ?? ''}
                            maxLength={300}
                            onChange={(event) => setMember(index, 'linkedin', event.target.value)}
                          />
                        )}
                      </Field>
                      <Field
                        id={ids.member(index, 'bio')}
                        label={t('fields.memberBio')}
                        requiredLabel={requiredLabel}
                        className="sm:col-span-2"
                      >
                        {(control) => (
                          <Textarea
                            {...control}
                            value={member.bio ?? ''}
                            rows={3}
                            maxLength={1500}
                            onChange={(event) => setMember(index, 'bio', event.target.value)}
                          />
                        )}
                      </Field>
                    </div>
                    <div className="mt-3 flex justify-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeMember(index)}
                        aria-label={`${t('team.remove')}: ${t('team.member', { index: index + 1 })}`}
                      >
                        {t('team.remove')}
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          <Button type="button" variant="outline" size="sm" onClick={addMember}>
            {t('team.add')}
          </Button>
        </fieldset>

        {withContact ? (
          <fieldset className="min-w-0 space-y-4" data-testid="company-profile-contact">
            <legend className="text-foreground text-base font-semibold">{contactT('title')}</legend>
            <p className="text-muted-foreground -mt-2 text-sm">{contactT('description')}</p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">{contactT('emailLabel')}</p>
                {contactLoading ? (
                  <p role="status" className="text-muted-foreground text-sm">
                    {contactT('emailLoading')}
                  </p>
                ) : (
                  <p className="text-sm">{user?.email ?? contactT('emailUnavailable')}</p>
                )}
                <p className="text-muted-foreground text-xs">{contactT('emailHint')}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor={phoneId}>{contactT('phoneLabel')}</Label>
                <Input
                  ref={phoneRef}
                  id={phoneId}
                  type="tel"
                  autoComplete="tel"
                  maxLength={50}
                  value={phoneValue}
                  aria-invalid={phoneError !== null}
                  aria-describedby={`${phoneId}-hint${phoneError ? ` ${phoneId}-error` : ''}`}
                  onChange={(event) => {
                    setPhone(event.target.value)
                    setPhoneError(null)
                  }}
                />
                <p id={`${phoneId}-hint`} className="text-muted-foreground text-xs">
                  {contactT('phoneHint')}
                </p>
                {phoneError ? (
                  <p id={`${phoneId}-error`} role="alert" className="text-destructive text-sm">
                    {phoneError === 'invalid' ? contactT('invalidPhone') : contactT('saveError')}
                  </p>
                ) : null}
              </div>
            </div>
          </fieldset>
        ) : null}

        {/* Pie fijo: el único Guardar se ve sin scroll, con su estado al lado. */}
        <div
          data-testid="company-profile-footer"
          className="bg-background border-border sticky bottom-0 -mx-4 flex flex-wrap items-center justify-end gap-3 border-t px-4 py-3 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
        >
          {saveFailed ? (
            <p role="alert" className="text-destructive mr-auto text-sm">
              {t('saveError')}
            </p>
          ) : null}
          <Button type="submit" data-replay-ui="true" disabled={saving}>
            {saving ? t('saving') : t('save')}
          </Button>
        </div>
      </form>
    </section>
  )
}
