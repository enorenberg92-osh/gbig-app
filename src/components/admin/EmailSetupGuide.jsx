import React, { useState } from 'react'
import { Button } from '../ui'
import { emailSetupGuide } from '../../lib/emailSetupGuide'

const STEPS = ['Check connection', 'Approve senders', 'Verify domain', 'Private test']
const statusLabel = value => value === true ? 'Present' : value === false ? 'Action needed' : 'Not checked'

export default function EmailSetupGuide({ setup, senders, locationId, venueSlug, venueName, busy, onRefresh, onCompose }) {
  const [step, setStep] = useState(0)
  const [copyNotice, setCopyNotice] = useState('')
  const guide = emailSetupGuide({ setup, senders, locationId, venueSlug, venueName })

  async function copyRequest() {
    try {
      await navigator.clipboard.writeText(guide.request)
      setCopyNotice('Setup request copied. Share it with your owner or app maintainer.')
    } catch {
      setCopyNotice('Copy was blocked. Select and copy the setup request below.')
    }
  }

  return <details className="email-setup-guide" open={!setup?.configured}>
    <summary>Owner setup · four simple steps</summary>
    <p>Set up email once for {venueName || 'this venue'}. Staff can then choose From, enter their message, preview, and send inside the app.</p>
    <nav aria-label="Email setup steps" className="email-setup-steps">
      {STEPS.map((label, index) => <button key={label} type="button" aria-current={step === index ? 'step' : undefined} onClick={() => setStep(index)}>{index + 1}. {label}</button>)}
    </nav>
    <div className="email-setup-step" role="region" aria-label={`Step ${step + 1}: ${STEPS[step]}`}>
      <p className="closeout-muted">Step {step + 1} of {STEPS.length}</p>
      {step === 0 && <>
        <h4>Check the app connection</h4>
        <dl className="weekly-email-details">
          <dt>Email storage</dt><dd>{statusLabel(guide.readiness.storage)}</dd>
          <dt>Email service connection</dt><dd>{statusLabel(guide.readiness.serviceKey)}</dd>
        </dl>
        <p>If action is needed, copy the setup request below for your app maintainer. After they finish, choose Refresh readiness.</p>
        <p>Keep credentials in the secure provider dashboard. The server setting is named <code>RESEND_API_KEY</code>; never paste a key into this app.</p>
        <Button variant="secondary" disabled={busy} onClick={onRefresh}>Refresh readiness</Button>
      </>}
      {step === 1 && <>
        <h4>Approve who can send</h4>
        <p><strong>Your sender access:</strong> {statusLabel(guide.readiness.sender)}</p>
        {guide.initialSender && <p><strong>Initial venue sender:</strong> {guide.initialSender}</p>}
        {senders?.length > 0 && <ul>{senders.map(sender => <li key={sender.id}>{sender.from}</li>)}</ul>}
        <p>The owner approves each staff account and sender for this venue. Copy the setup request to make that approval specific. Multiple approved senders appear in the From menu.</p>
        <p>For a new location, use the same steps with its own verified sender domain and staff account IDs.</p>
        <p>A sender address does not identify a staff account. This guide does not change anyone’s permissions.</p>
      </>}
      {step === 2 && <>
        <h4>Verify the sending domain</h4>
        {guide.domains.length > 0 && <p><strong>Domains to review:</strong> {guide.domains.join(', ')}</p>}
        <ol>
          <li><a href="https://resend.com/domains" target="_blank" rel="noopener noreferrer">Open Resend Domains</a> and choose the sending domain. Reuse its existing record if present.</li>
          <li>If it is unverified, the domain owner copies Resend’s exact DNS records into their DNS provider and waits for verification.</li>
          <li>Confirm the existing sending key is allowed to send from this domain. Have the owner approve any provider or credential change.</li>
        </ol>
        <p>Domain verification and key validity require owner review. A green configuration check does not confirm either, and this guide never changes DNS or credentials.</p>
      </>}
      {step === 3 && <>
        <h4>Approve one private delivery test</h4>
        <ol>
          <li>Open the composer below. Its To address starts blank; enter the one approved recipient.</li>
          <li>Enter the subject and complete message. Choose Preview email.</li>
          <li>Approve the exact From, To, subject, and message before choosing Send email.</li>
          <li>Check the recipient’s inbox. “Accepted by email service” confirms provider acceptance only.</li>
        </ol>
        <p>This test needs no round, uses no league audience, and creates no app notification. Nothing is sent during setup.</p>
        <Button disabled={busy} onClick={onCompose}>Go to email composer</Button>
      </>}
    </div>
    <div className="email-setup-navigation">
      <Button variant="secondary" disabled={step === 0} onClick={() => setStep(index => index - 1)}>Back</Button>
      <Button variant="secondary" disabled={step === STEPS.length - 1} onClick={() => setStep(index => index + 1)}>Next step</Button>
    </div>
    <details className="email-setup-request">
      <summary>Copy-paste request for your app maintainer</summary>
      <p>Contains setup instructions and account identifiers, with no credentials or email message.</p>
      <pre tabIndex={0}>{guide.request}</pre>
      <Button variant="secondary" onClick={copyRequest}>Copy setup request</Button>
      {copyNotice && <p role="status">{copyNotice}</p>}
    </details>
  </details>
}
