import { useTranslations } from 'next-intl'
import { Schema } from 'effect'
import { LoaderCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ThemeToggle } from '@/components/ui/theme-toggle'
import { SYNTHETIC_SHOWCASE_FIXTURES } from './showcase-fixtures'
import {
  Example,
  SHOWCASE_CONTROLS_ANCHOR_ID,
  SHOWCASE_FEEDBACK_ANCHOR_ID,
  ShowcaseSection,
} from './ShowcaseSection'

// La etapa de la empresa y las pestañas de ejemplo: un catálogo cada una.
// Recorrer `.literals` evita repetir los valores en el JSX y en el copy.
const CompanyStageSchema = Schema.Literals(['growth', 'mature'])
type CompanyStage = typeof CompanyStageSchema.Type
const COMPANY_STAGE_LABEL_KEY = {
  growth: 'content.growth',
  mature: 'content.mature',
} satisfies Record<CompanyStage, string>

const ControlsTabSchema = Schema.Literals(['overview', 'documents', 'review'])
type ControlsTab = typeof ControlsTabSchema.Type
const CONTROLS_TAB_LABEL_KEY = {
  overview: 'content.overview',
  documents: 'content.documents',
  review: 'states.pending',
} satisfies Record<ControlsTab, string>
const CONTROLS_TAB_DISABLED = {
  overview: false,
  documents: false,
  review: true,
} satisfies Record<ControlsTab, boolean>
const ControlsTabBodySchema = ControlsTabSchema.pick(['overview', 'documents'])
type ControlsTabBody = typeof ControlsTabBodySchema.Type
const CONTROLS_TAB_BODY_KEY = {
  overview: 'content.body',
  documents: 'content.legalBody',
} satisfies Record<ControlsTabBody, string>

export function ControlsShowcase() {
  const t = useTranslations('designSystem')

  return (
    <div id={SHOWCASE_CONTROLS_ANCHOR_ID}>
      <ShowcaseSection title={t('families.controls')} description={t('descriptions.controls')}>
        <div className="grid gap-4 lg:grid-cols-2">
          <Example label={t('examples.buttons')}>
            <div className="flex flex-wrap items-center gap-3">
              <Button data-testid="showcase-button-default">{t('actions.request')}</Button>
              <Button data-testid="showcase-button-interactive" variant="outline">
                {t('actions.review')}
              </Button>
              <Button disabled>{t('states.disabled')}</Button>
              <Button disabled aria-busy="true">
                <LoaderCircle
                  className="animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                {t('states.loading')}
              </Button>
            </div>
          </Example>
          <Example label={t('examples.inputs')}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="showcase-company">{t('content.company')}</Label>
                <Input id="showcase-company" defaultValue={t('content.companyExample')} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="showcase-error">{t('states.error')}</Label>
                <Input
                  id="showcase-error"
                  aria-describedby="showcase-error-message"
                  aria-invalid="true"
                  defaultValue={SYNTHETIC_SHOWCASE_FIXTURES.invalidReference}
                  className="border-destructive"
                />
                <p id="showcase-error-message" className="text-destructive text-xs">
                  {t('feedback.inputError')}
                </p>
              </div>
            </div>
          </Example>
          <Example label={t('examples.tabs')}>
            <Tabs defaultValue={ControlsTabSchema.literals[0]}>
              <TabsList className="h-auto max-w-full flex-wrap justify-start">
                {ControlsTabSchema.literals.map((tab) => (
                  <TabsTrigger key={tab} value={tab} disabled={CONTROLS_TAB_DISABLED[tab]}>
                    {t(CONTROLS_TAB_LABEL_KEY[tab])}
                  </TabsTrigger>
                ))}
              </TabsList>
              {ControlsTabBodySchema.literals.map((tab) => (
                <TabsContent key={tab} value={tab} className="text-muted-foreground text-sm">
                  {t(CONTROLS_TAB_BODY_KEY[tab])}
                </TabsContent>
              ))}
            </Tabs>
          </Example>
          <Example label={t('examples.selectMenu')}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Select defaultValue={CompanyStageSchema.literals[0]}>
                <SelectTrigger data-testid="showcase-select" aria-label={t('content.stage')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CompanyStageSchema.literals.map((stage) => (
                    <SelectItem key={stage} value={stage}>
                      {t(COMPANY_STAGE_LABEL_KEY[stage])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button data-testid="showcase-menu" variant="outline">
                    {t('actions.openMenu')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem>{t('actions.review')}</DropdownMenuItem>
                  <DropdownMenuItem>{t('actions.request')}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </Example>
          <Example label={t('examples.preferences')}>
            <div className="flex items-center gap-2">
              <ThemeToggle triggerId="showcase-theme-menu-trigger" />
              <a
                href={`#${SHOWCASE_FEEDBACK_ANCHOR_ID}`}
                className="text-primary rounded-sm underline underline-offset-4 focus-visible:ring-2"
              >
                {t('actions.viewStates')}
              </a>
            </div>
          </Example>
        </div>
      </ShowcaseSection>
    </div>
  )
}
