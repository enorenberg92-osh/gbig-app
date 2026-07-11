export function mutationErrorMessage(error, action = 'complete this action') {
  const message = error?.message || 'Unknown database error'
  const missingFunction = error?.code === 'PGRST202' || /function .* does not exist|schema cache/i.test(message)
  if (missingFunction) {
    return `The Phase 1 database migrations must be applied before you can ${action}. Ask an administrator to update the database.`
  }
  return message
}

