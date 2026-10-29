'use client'

// El panel de invitados pide la capacidad admin de la sala antes de invitar o
// revocar. En la página de documentos del equipo tiene que vivir dentro del
// provider con el id de esa empresa: fuera, authorize() manda la mutation sin
// bearer y el equipo ve el fallo genérico.

import type { Id } from '@/../convex/_generated/dataModel'
import { AdminVdrCapabilityProvider } from '@/components/company/vdr/AdminVdrCapabilityContext'
import { CompanyGuestScreen } from '@/components/vdr-guest/CompanyGuestScreen'

import { AdminCompanyNdaSection } from './AdminCompanyNdaSection'

export function AdminCompanyGuestAccess({ companyId }: { companyId: Id<'companies'> }) {
  return (
    <AdminVdrCapabilityProvider companyId={companyId}>
      <AdminCompanyNdaSection companyId={companyId} />
      <CompanyGuestScreen companyId={companyId} locale="es" />
    </AdminVdrCapabilityProvider>
  )
}
