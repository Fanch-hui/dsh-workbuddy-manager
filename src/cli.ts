#!/usr/bin/env node
import { CliError, HELP_TEXT, parseArgs } from './cli-config.js'
import { WorkbuddyManagerClient } from './client.js'
import { runDoctor } from './doctor.js'
import { snapshot } from './status.js'

async function main(): Promise<number> {
  const { command, options, help } = parseArgs(process.argv.slice(2))
  if (help) {
    process.stdout.write(HELP_TEXT)
    return 0
  }

  const client = new WorkbuddyManagerClient(options)
  if (command === 'doctor') {
    const checks = await runDoctor(client, options)
    for (const item of checks) {
      process.stdout.write(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}  ${item.detail}\n`)
    }
    const passed = checks.filter(item => item.ok).length
    process.stdout.write(`\n${passed}/${checks.length} 项通过\n`)
    return passed === checks.length ? 0 : 1
  }

  const value = await runCommand(client, command)
  process.stdout.write(`${JSON.stringify(value, null, options.json ? 0 : 2)}\n`)
  return 0
}

function runCommand(client: WorkbuddyManagerClient, command: string): Promise<unknown> {
  switch (command) {
    case 'status': return snapshot(client)
    case 'models': return client.models()
    case 'usage': return client.usage()
    case 'me': return client.me()
    case 'accounts': return client.accounts()
    case 'credits': return client.credits()
    default: throw new CliError(`未知命令：${command}`)
  }
}

main().then(
  code => { process.exitCode = code },
  error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  },
)
