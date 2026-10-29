// Los tres enlaces legales del pie. `SiteFooter` (landing) y `ProductFooter`
// (sala) los escribían cada uno por su lado con las mismas tres llaves de
// copy y el mismo href — nada ataba las dos listas, así que un aviso legal
// nuevo podía llegar a un pie y no al otro. La fuente única vive acá: el
// catálogo es un schema y la tabla de hrefs se ata a sus literales.
import { Schema } from 'effect'

const FooterLegalKeySchema = Schema.Literals([
  'footer.legal.privacy',
  'footer.legal.terms',
  'footer.legal.notices',
])
type FooterLegalKey = typeof FooterLegalKeySchema.Type

const FOOTER_LEGAL_HREFS = {
  'footer.legal.privacy': '/privacy',
  'footer.legal.terms': '/terms',
  'footer.legal.notices': '/legal',
} satisfies Record<FooterLegalKey, string>

export const FOOTER_LEGAL_LINKS = FooterLegalKeySchema.literals.map((key) => ({
  key,
  href: FOOTER_LEGAL_HREFS[key],
}))
