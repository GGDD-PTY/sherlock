import { Schema } from 'effect'

import DocumentsLoading from './documents/loading'

const LiveChildSchema = Schema.Literals(['documents'])

export default function MyCompanyLoading() {
  return <DocumentsLoading key={LiveChildSchema.literals[0]} />
}
