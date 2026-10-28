import { describe, expect, it } from 'vitest'
import { AWS_EXPIRED, readSsoSession } from './aws'

describe('readSsoSession', () => {
  it('finds the sso-session and a profile using it', () => {
    const cfg = '[sso-session productive]\nsso_start_url = https://x.awsapps.com/start\nsso_region = eu-west-1\n\n[default]\nsso_session = productive\n'
    expect(readSsoSession(cfg)).toEqual({ session: 'productive', startUrl: 'https://x.awsapps.com/start', region: 'eu-west-1', profile: 'default' })
  })
  it('is null without one', () => {
    expect(readSsoSession('[default]\nregion = eu-west-1\n')).toBeNull()
  })
})

describe('AWS_EXPIRED', () => {
  it('matches the SDK and CLI messages', () => {
    expect(AWS_EXPIRED.test("Token is expired. To refresh this SSO session run 'aws sso login'")).toBe(true)
    expect(AWS_EXPIRED.test('ExpiredTokenException: The security token included in the request is expired')).toBe(true)
    expect(AWS_EXPIRED.test('Aws::Errors::InvalidSSOToken: Token is invalid and failed to refresh.')).toBe(true)
    expect(AWS_EXPIRED.test('Error: listen EADDRINUSE :3100')).toBe(false)
  })
})
