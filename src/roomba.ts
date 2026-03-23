import type { IncomingMessage } from 'node:http'

import { Buffer } from 'node:buffer'
import * as dgram from 'node:dgram'
import * as https from 'node:https'

export interface Logger {
  info(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  debug(message: string, ...args: unknown[]): void
}

export async function getRoombas(email: string, password: string, log: Logger): Promise<Robot[]> {
  log.info('Logging into iRobot...')

  let robots: Robot[] = []

  try {
    const credentials = await getCredentials(email, password)
    robots = await iRobotLogin(credentials)
    log.debug('robots: %s', JSON.stringify(robots))
  } catch (e: any) {
    log.error('Failed to login to iRobot: %s', e.message ?? e)
    return []
  }

  // Extract the key from the JSON object and set it as the blid if not provided or if blid is 0
  for (const key in robots) {
    if (Object.prototype.hasOwnProperty.call(robots, key)) {
      const robot = robots[key as any]
      if (!robot.blid || robot.blid === '0') {
        robot.blid = key
        log.debug('Set blid for robot %s to %s', robot.name, robot.blid)
      }
    }
  }

  // Ensure robots is an array
  if (!Array.isArray(robots)) {
    log.debug('Converting robots object to array')
    robots = Object.values(robots)
  }

  log.debug('Processed robots: %s', JSON.stringify(robots))

  const goodRoombas: Robot[] = []

  for (const robot of robots) {
    log.debug('roomba name: %s blid: %s password: %s', robot.name, robot.blid, robot.password)
    if (!robot.name || !robot.blid || !robot.password) {
      log.error('Skipping robot %s due to missing name, blid or password', robot.name)
      continue
    }

    log.info('Configuring roomba: %s', robot.name)

    try {
      const robotIP = await getIP(robot.blid)
      robot.ip = robotIP.ip
      robot.model = getModel(robotIP.sku)
      robot.multiRoom = getMultiRoom(robot.model)
      robot.info = robotIP
      goodRoombas.push(robot)
    } catch (e: any) {
      log.error('Failed to connect roomba %s: %s', robot.name, e.message ?? e)
    }
  }

  return goodRoombas
}

function getModel(sku: string): string {
  switch (sku.charAt(0)) {
    case 'j':
    case 'i':
    case 's':
      return sku.substring(0, 2)
    case 'R':
      return sku.substring(1, 4)
    default:
      return sku
  }
}

function getMultiRoom(model: string): boolean {
  switch (model.charAt(0)) {
    case 's':
    case 'j':
      return Number.parseInt(model.charAt(1)) > 4
    case 'i':
      return Number.parseInt(model.charAt(1)) > 2
    case 'm':
      return Number.parseInt(model.charAt(1)) === 6
    default:
      return false
  }
}

export interface Robot {
  name: string
  blid: string
  sku?: string
  password: string
  ip: string
  model: string
  multiRoom: boolean
  softwareVer?: string
  info: DeviceInfo
}

export interface DeviceInfo {
  serialNum?: string
  ver?: string
  hostname?: string
  robotname?: string
  robotid?: string
  mac?: string
  sw: string
  sku?: string
  nc?: number
  proto?: string
  cap?: object
}

async function getIP(blid: string, attempt: number = 1): Promise<any> {
  return new Promise((resolve, reject) => {
    if (attempt > 5) {
      reject(new Error(`No Roomba Found With Blid: ${blid}`))
      return
    }

    const server = dgram.createSocket('udp4')

    server.on('error', (err) => {
      reject(err)
    })

    server.on('message', (msg) => {
      try {
        const parsedMsg = JSON.parse(msg.toString())
        const [prefix, id] = parsedMsg.hostname.split('-')
        if ((prefix === 'Roomba' || prefix === 'iRobot') && id === blid) {
          server.close()
          resolve(parsedMsg)
        }
      } catch (_e) { /* ignore */ }
    })

    server.on('listening', () => {
      setTimeout(() => {
        getIP(blid, attempt + 1).then(resolve).catch(reject)
      }, 5000)
    })

    server.bind(() => {
      const message = Buffer.from('irobotmcs')
      server.setBroadcast(true)
      server.send(message, 0, message.length, 5678, '255.255.255.255')
    })
  })
}

async function getCredentials(email: string, password: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const apiKey = '3_rWtvxmUKwgOzu3AUPTMLnM46lj-LxURGflmu5PcE_sGptTbD-wMeshVbLvYpq01K'
    const gigyaURL = new URL('https://accounts.us1.gigya.com/accounts.login')
    gigyaURL.search = new URLSearchParams({
      apiKey,
      targetenv: 'mobile',
      loginID: email,
      password,
      format: 'json',
      targetEnv: 'mobile',
    }).toString()

    const gigyaLoginOptions = {
      hostname: gigyaURL.hostname,
      path: gigyaURL.pathname + gigyaURL.search,
      method: 'POST',
      headers: { Connection: 'close' },
    }

    const req = https.request(gigyaLoginOptions, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => { gigyaLoginResponse(null, res, JSON.parse(data), resolve, reject) })
    })

    req.on('error', (error) => { gigyaLoginResponse(error, undefined, undefined, resolve, reject) })
    req.end()
  })
}

function gigyaLoginResponse(error: Error | null, response?: IncomingMessage, body?: any, resolve?: (value: any) => void, reject?: (reason?: any) => void): void {
  if (error) {
    reject?.(new Error(`Fatal error logging into Gigya API. ${error.message}`))
    return
  }

  if (response?.statusCode !== undefined && [401, 403].includes(response.statusCode)) {
    reject?.(new Error(`Authentication error. Check your credentials. ${response.statusCode}`))
  } else if (response && response.statusCode === 400) {
    reject?.(new Error(`Error logging into Gigya API. ${response.statusCode}`))
  } else if (response && response.statusCode === 200) {
    gigyaSuccess(body, resolve, reject)
  } else {
    reject?.(new Error('Unexpected response from Gigya.'))
  }
}

function gigyaSuccess(body: any, resolve?: (value: any) => void, reject?: (reason?: any) => void): void {
  if (body.statusCode === 403) {
    reject?.(new Error(`Authentication error. ${body.statusCode}`))
    return
  }
  if (body.statusCode === 400) {
    reject?.(new Error(`Error logging into Gigya API. ${body.statusCode}`))
    return
  }
  if (body.statusCode === 200 && body.errorCode === 0 && body.UID && body.UIDSignature && body.signatureTimestamp && body.sessionInfo?.sessionToken) {
    resolve?.(body)
  } else {
    reject?.(new Error(`Error logging into iRobot account. Missing fields. ${body.statusCode}`))
  }
}

async function iRobotLogin(body: any, server: number = 1): Promise<any> {
  return new Promise((resolve, reject) => {
    const iRobotLoginOptions = {
      hostname: `unauth${server}.prod.iot.irobotapi.com`,
      path: '/v2/login',
      method: 'POST',
      headers: { 'Connection': 'close', 'Content-Type': 'application/json' },
    }

    const req = https.request(iRobotLoginOptions, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          iRobotLoginResponse(null, res, JSON.parse(data), resolve, reject)
        } catch (e: any) {
          if (server === 1) {
            iRobotLogin(body, 2).then(resolve).catch(reject)
          } else {
            iRobotLoginResponse(e.message ?? e, undefined, undefined, resolve, reject)
          }
        }
      })
    })

    req.on('error', (error) => { iRobotLoginResponse(error, undefined, undefined, resolve, reject) })

    req.write(JSON.stringify({
      app_id: 'ANDROID-C7FB240E-DF34-42D7-AE4E-A8C17079A294',
      assume_robot_ownership: 0,
      gigya: {
        signature: body.UIDSignature,
        timestamp: body.signatureTimestamp,
        uid: body.UID,
      },
    }))

    req.end()
  })
}

function iRobotLoginResponse(error: Error | null, _response?: IncomingMessage, body?: any, resolve?: (value: any) => void, reject?: (reason?: any) => void): void {
  if (error) {
    reject?.(new Error(`Fatal error logging into iRobot account. ${(error as Error).message}`))
    return
  }
  if (body?.robots) {
    resolve?.(body.robots)
  } else {
    reject?.(new Error(`Fatal error logging into iRobot account. ${body?.statusCode}`))
  }
}

