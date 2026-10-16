import React, { useState } from 'react'
import { Button } from '../ui'
import { emailSetupGuide } from '../../lib/emailSetupGuide'
import GmailConnections from './GmailConnections'

const STEPS = ['Connect Gmail', 'Approve senders', 'Review connection', 'Private test']
const statusLabel = value => value === true ? 'Present' : value === false ? 'Action needed' : 'Not checked'

export default function EmailSetupGuide({ setup, senders, locationId, venueSlug, venueName, busy, onRefresh, onCompose, onConnectBusyChange }) {
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
        <h4>Connect your existing Gmail account</h4>
        <dl className="weekly-email-details">
          <dt>Email storage</dt><dd>{statusLabel(guide.readiness.storage)}</dd>
          <dt>Gmail connection for an enabled sender</dt><dd>{statusLabel(guide.readiness.serviceKey)}</dd>
        </dl>
        <p>If action is needed, copy the setup request below for your app maintainer. After they finish, choose Refresh readiness.</p>
        <GmailConnections gmail={setup?.gmail} disabled={busy} onBusyChange={onConnectBusyChange}/>
        <Button variant="secondary" disabled={busy} onClick={onRefresh}>Refresh readiness</Button>
      </>}
      {step === 1 && <>
        <h4>Approve who can send</h4>
        <p><strong>Your sender access:</strong> {statusLabel(guide.readiness.sender)}</p>
        {guide.initialSender && <p><strong>Initial venue sender:</strong> {guide.initialSender}</p>}
        {senders?.length > 0 && <ul>{senders.map(sender => <li key={sender.id}>{sender.from}</li>)}</ul>}
        <p>The owner approves each staff account and sender for this venue. Copy the setup request to make that approval specific. Multiple approved senders appear in the From menu.</p>
        <p>For a new location, approve its own Gmail sender and staff account IDs.</p>
        <p>A sender address does not identify a staff account. This guide does not change anyone’s permissions.</p>
      </>}
      {step === 2 && <>
        <h4>Review the Gmail connection</h4>
        <ol>
          <li>Connect the Gmail account whose sign-in address exactly matches the approved From address.</li>
          <li>Choose Refresh readiness to see the saved connection and sender activation status.</li>
          <li>The owner approves sender activation separately. Gmail’s account sending limits still apply.</li>
        </ol>
        <p>This uses your existing Gmail service. No DNS changes are part of this setup. A saved connection does not confirm that its authorization is still valid or that a message reached an inbox.</p>
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
