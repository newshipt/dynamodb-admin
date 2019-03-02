#!/usr/bin/env node

const ArgumentParser = require('argparse').ArgumentParser
const opn = require('opn')
const packageJson = require('../package.json')

const { createServer } = require('../lib/backend')

if (process.env.NODE_ENV === 'production') {
  const clc = require('cli-color')
  console.error(clc.red('Do not run this in production!'))
  process.exit(1)
}

const parser = new ArgumentParser({
  description: packageJson.description,
  version: packageJson.version,
})

parser.addArgument(['-o', '--open'], {
  action: 'storeTrue',
  help: 'Open server URL in default browser on start',
})

parser.addArgument(['-h', '--host'], {
  type: 'string',
  defaultValue: 'localhost',
  help: 'Hostname or IP to run on (default: localhost)',
})

parser.addArgument(['-p', '--port'], {
  type: 'int',
  defaultValue: 8001,
  help: 'Port to run on (default: 8001)',
})

const args = parser.parseArgs()

const app = createServer()
const host = process.env.HOST || args.host
const port = process.env.PORT || args.port
const server = app.listen(port, host)
server.on('listening', () => {
  const host_actual = server.address().host
  const port_actual = server.address().port
  console.log(` dynamodb-admin listening on http://${host_actual}:${port_actual}`)

  if (args.open) {
    opn(url)
  }
})

process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
})
