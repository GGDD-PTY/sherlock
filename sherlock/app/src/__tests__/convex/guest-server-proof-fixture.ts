import type { VdrGuestServerOperation } from '../../../convex/_guests/serverProofFormat'
import { createVdrGuestServerProof } from '../../lib/auth/vdr-guest-server-proof'

const TEST_VDR_GUEST_SERVER_SECRET = 'server-boundary-secret-for-tests-123456789'
const TEST_VDR_GUEST_SERVER_AUDIENCE = 'sherlock-test:guest-boundary'

export function withGuestServerProof<T extends Record<string, unknown>>(
  operation: VdrGuestServerOperation,
  bindingParts: readonly string[],
  args: T,
  issuedAt = Date.now()
): T & { serverIssuedAt: number; serverProof: string } {
  return {
    ...args,
    ...createVdrGuestServerProof({
      operation,
      bindingParts,
      issuedAt,
      secret: TEST_VDR_GUEST_SERVER_SECRET,
      audience: TEST_VDR_GUEST_SERVER_AUDIENCE,
    }),
  }
}
