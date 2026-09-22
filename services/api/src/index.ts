// Lambda entry point.
//
// Reachable only through CloudFront, which signs its requests with an Origin
// Access Control; the Function URL's authorization type is AWS_IAM, so a
// direct call returns 403 before this code runs.

import { buildRouter } from './app.js'
import { loadConfig } from './config.js'
import type { App } from './context.js'
import { type LambdaEvent, type LambdaResponse, errorResponse } from './http.js'
import { DynamoStore } from './store-dynamo.js'

let app: App | null = null

async function getApp(): Promise<App> {
  if (app) return app
  const config = await loadConfig()
  app = {
    config,
    store: new DynamoStore(config.tableName, config.region),
    now: () => Date.now(),
    // Closed unless explicitly opened, so a missing or misspelled setting
    // refuses registration rather than leaving the vault open to anyone who
    // finds the URL. Opened for the first signup, then set back to false.
    allowRegistration: process.env['ALLOW_REGISTRATION'] === 'true',
  }
  return app
}

export const handler = async (event: LambdaEvent): Promise<LambdaResponse> => {
  try {
    const ready = await getApp()
    return await buildRouter(ready).handle(event)
  } catch (err) {
    return errorResponse(err)
  }
}
