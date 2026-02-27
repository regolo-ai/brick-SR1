/**
 * Offline routing test logic — keyword matching fallback.
 * Ported from Python route_test.py
 */

import {execaSync} from 'execa'
import * as fs from 'node:fs'
import type {MyModelConfig} from './config/schema.js'

export interface RoutingResult {
  query: string
  modality: string
  signals: string[]
  route_name: string
  provider: string
  model: string
  reason: string
  latency_ms?: number
  blocked?: boolean
  block_reason?: string
}

/**
 * Try running the Go binary with --route-test flag.
 */
export function tryGoBinary(query: string, configPath: string): RoutingResult | null {
  const binaries = ['mymodel-router', 'semantic-router', './semantic-router']
  for (const binary of binaries) {
    try {
      const result = execaSync(binary, ['--route-test', query, '--config', configPath], {
        timeout: 10000,
      })
      if (result.exitCode === 0 && result.stdout.trim()) {
        return JSON.parse(result.stdout) as RoutingResult
      }
    } catch {
      // Binary not found or failed, try next
    }
  }
  return null
}

/**
 * Simple keyword matching against text routes.
 */
export function keywordMatch(query: string, config: MyModelConfig): RoutingResult {
  const queryLower = query.toLowerCase()
  let bestRoute: typeof config.text_routes[0] | null = null
  let bestPriority = -1
  let matchedSignals: string[] = []

  for (const route of config.text_routes) {
    if (route.name === 'default') continue

    const routeSignals: string[] = []
    let keywordHit = false
    let domainHit = false

    // Check keywords
    if (route.signals.keywords.length > 0) {
      const matchedKw = route.signals.keywords.filter(kw => queryLower.includes(kw.toLowerCase()))
      if (matchedKw.length > 0) {
        keywordHit = true
        routeSignals.push(`keyword:${route.name} (matched: ${matchedKw.slice(0, 3).join(', ')})`)
      }
    }

    // Check domains (simple heuristic)
    if (route.signals.domains.length > 0) {
      for (const domain of route.signals.domains) {
        const domainWords = domain.toLowerCase().replace(/_/g, ' ').split(' ')
        if (domainWords.some(dw => queryLower.includes(dw))) {
          domainHit = true
          routeSignals.push(`domain:${domain}`)
          break
        }
      }
    }

    // Apply operator
    let hit = false
    if (route.operator === 'OR') {
      hit = keywordHit || domainHit
    } else {
      // AND
      const hasKw = route.signals.keywords.length > 0
      const hasDm = route.signals.domains.length > 0
      if (hasKw && hasDm) {
        hit = keywordHit && domainHit
      } else if (hasKw) {
        hit = keywordHit
      } else if (hasDm) {
        hit = domainHit
      }
    }

    if (hit && route.priority > bestPriority) {
      bestRoute = route
      bestPriority = route.priority
      matchedSignals = routeSignals
    }
  }

  // Fallback to default route
  if (!bestRoute) {
    bestRoute = config.text_routes.find(r => r.name === 'default') ?? null
  }
  if (!bestRoute && config.text_routes.length > 0) {
    bestRoute = config.text_routes[0]
  }

  if (!bestRoute) {
    return {
      query,
      modality: 'text',
      signals: [],
      route_name: 'none',
      provider: '',
      model: '',
      reason: 'No routes configured',
    }
  }

  const reason = matchedSignals.length > 0
    ? `priority ${bestRoute.priority}, operator ${bestRoute.operator}`
    : 'default fallback (no signals matched)'

  return {
    query,
    modality: 'text',
    signals: matchedSignals,
    route_name: bestRoute.name,
    provider: bestRoute.provider,
    model: bestRoute.model,
    reason,
  }
}
