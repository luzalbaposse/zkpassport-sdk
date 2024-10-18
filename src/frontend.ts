import { randomBytes } from 'crypto'
import { Alpha2Code, Alpha3Code } from 'i18n-iso-countries'
import { IDCredential, IDCredentialConfig, IDCredentialValue, NumericalIDCredential } from './types/credentials'
import { Proof } from './types/proof'
import { CountryName } from './types/countries'
import { UltraHonkBackend, ProofData, CompiledCircuit } from '@noir-lang/backend_barretenberg'
import { bytesToHex } from '@noble/ciphers/utils'
import { getWebSocketClient, WebSocketClient } from './websocket'
import { createEncryptedJsonRpcRequest, createJsonRpcRequest } from './json-rpc'
import { decrypt, encrypt, generateECDHKeyPair, getSharedSecret } from './encryption'
import { JsonRpcRequest } from './types/json-rpc'
import proofOfAgeCircuit from './circuits/proof_age.json'
import constants from './constants'
import logger from './logger'

function numericalCompare(
  fnName: 'gte' | 'gt' | 'lte' | 'lt',
  key: NumericalIDCredential,
  value: number | Date,
  requestId: string,
  requestIdToConfig: Record<string, Record<string, IDCredentialConfig>>,
) {
  requestIdToConfig[requestId][key] = {
    ...requestIdToConfig[requestId][key],
    [fnName]: value,
  }
}

function rangeCompare(
  key: NumericalIDCredential,
  value: [number | Date, number | Date],
  requestId: string,
  requestIdToConfig: Record<string, Record<string, IDCredentialConfig>>,
) {
  requestIdToConfig[requestId][key] = {
    ...requestIdToConfig[requestId][key],
    range: value,
  }
}

function generalCompare(
  fnName: 'in' | 'out' | 'eq',
  key: IDCredential,
  value: any,
  requestId: string,
  requestIdToConfig: Record<string, Record<string, IDCredentialConfig>>,
) {
  requestIdToConfig[requestId][key] = {
    ...requestIdToConfig[requestId][key],
    [fnName]: value,
  }
}

export class ZkPassport {
  private domain: string
  private topicToConfig: Record<string, Record<string, IDCredentialConfig>> = {}
  private topicToKeyPair: Record<string, { privateKey: Uint8Array; publicKey: Uint8Array }> = {}
  private topicToWebSocketClient: Record<string, WebSocketClient> = {}
  private topicToSharedSecret: Record<string, Uint8Array> = {}

  private qrCodeScannedCallbacks: Array<() => void> = []
  private onGeneratingProofCallbacks: Array<(topic: string) => void> = []
  private onProofGeneratedCallbacks: Array<(topic: string) => void> = []
  private onRejectCallbacks: Array<() => void> = []
  private onErrorCallbacks: Array<(topic: string) => void> = []

  constructor(_domain: string) {
    this.domain = _domain
  }

  /**
   * @notice Handle an encrypted message.
   * @param request The request.
   * @param outerRequest The outer request.
   */
  private handleEncryptedMessage(topic: string, request: JsonRpcRequest, outerRequest: JsonRpcRequest) {
    logger.debug('Received encrypted message:', request)
    if (request.method === 'accept') {
      logger.debug(`User accepted the request and is generating a proof`)
      this.onGeneratingProofCallbacks.forEach((callback) => callback(topic))
    } else if (request.method === 'reject') {
      logger.debug(`User rejected the request`)
      this.onRejectCallbacks.forEach((callback) => callback())
    } else if (request.method === 'done') {
      logger.debug(`User generated proof`)
      this.onProofGeneratedCallbacks.forEach((callback) => callback(request.params.proof))
    } else if (request.method === 'error') {
      this.onErrorCallbacks.forEach((callback) => callback(request.params.error))
    }
  }

  private getZkPassportRequest(topic: string) {
    return {
      eq: <T extends IDCredential>(key: T, value: IDCredentialValue<T>) => {
        generalCompare('eq', key, value, topic, this.topicToConfig)
        return this.getZkPassportRequest(topic)
      },
      gte: <T extends NumericalIDCredential>(key: T, value: IDCredentialValue<T>) => {
        numericalCompare('gte', key, value, topic, this.topicToConfig)
        return this.getZkPassportRequest(topic)
      },
      gt: <T extends NumericalIDCredential>(key: T, value: IDCredentialValue<T>) => {
        numericalCompare('gt', key, value, topic, this.topicToConfig)
        return this.getZkPassportRequest(topic)
      },
      lte: <T extends NumericalIDCredential>(key: T, value: IDCredentialValue<T>) => {
        numericalCompare('lte', key, value, topic, this.topicToConfig)
        return this.getZkPassportRequest(topic)
      },
      lt: <T extends NumericalIDCredential>(key: T, value: IDCredentialValue<T>) => {
        numericalCompare('lt', key, value, topic, this.topicToConfig)
        return this.getZkPassportRequest(topic)
      },
      range: <T extends NumericalIDCredential>(key: T, start: IDCredentialValue<T>, end: IDCredentialValue<T>) => {
        rangeCompare(key, [start, end], topic, this.topicToConfig)
        return this.getZkPassportRequest(topic)
      },
      in: <T extends IDCredential>(key: T, value: IDCredentialValue<T>[]) => {
        generalCompare('in', key, value, topic, this.topicToConfig)
        return this.getZkPassportRequest(topic)
      },
      out: <T extends IDCredential>(key: T, value: IDCredentialValue<T>[]) => {
        generalCompare('out', key, value, topic, this.topicToConfig)
        return this.getZkPassportRequest(topic)
      },
      checkAML: (country?: CountryName | Alpha2Code | Alpha3Code) => {
        return this.getZkPassportRequest(topic)
      },
      done: () => {
        const base64Config = Buffer.from(JSON.stringify(this.topicToConfig[topic])).toString('base64')
        const pubkey = bytesToHex(this.topicToKeyPair[topic].publicKey)
        return {
          url: `https://zkpassport.id/r?d=${this.domain}&t=${topic}&c=${base64Config}&p=${pubkey}`,
          requestId: topic,
          onQRCodeScanned: (callback: () => void) => this.qrCodeScannedCallbacks.push(callback),
          onGeneratingProof: (callback: () => void) => this.onGeneratingProofCallbacks.push(callback),
          onProofGenerated: (callback: (proof: string) => void) => this.onProofGeneratedCallbacks.push(callback),
          onReject: (callback: () => void) => this.onRejectCallbacks.push(callback),
          onError: (callback: (error: string) => void) => this.onErrorCallbacks.push(callback),
        }
      },
    }
  }

  /**
   * @notice Create a new request.
   * @returns The query builder object.
   */
  public async request({
    topicOverride,
    keyPairOverride,
  }: {
    topicOverride?: string
    keyPairOverride?: { privateKey: Uint8Array; publicKey: Uint8Array }
  } = {}) {
    const keyPair = keyPairOverride || (await generateECDHKeyPair())

    const topic = topicOverride || randomBytes(16).toString('hex')
    this.topicToKeyPair[topic] = {
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
    }
    this.topicToConfig[topic] = {}
    const wsClient = getWebSocketClient(`wss://bridge.zkpassport.id?topic=${topic}`, this.domain)
    this.topicToWebSocketClient[topic] = wsClient
    wsClient.onopen = () => {
      logger.info('WebSocket connection established')
    }
    wsClient.addEventListener('message', async (event: any) => {
      logger.debug('Received message:', event.data)
      try {
        const data: JsonRpcRequest = JSON.parse(event.data)

        // Handshake happens when the mobile app scans the QR code and connects to the bridge
        if (data.method === 'handshake') {
          logger.debug('Received handshake:', event.data)

          this.topicToSharedSecret[topic] = await getSharedSecret(bytesToHex(keyPair.privateKey), data.params.pubkey)
          logger.debug('Shared secret:', Buffer.from(this.topicToSharedSecret[topic]).toString('hex'))

          const encryptedMessage = await createEncryptedJsonRpcRequest(
            'hello',
            null,
            this.topicToSharedSecret[topic],
            topic,
          )
          logger.debug('Sending encrypted message:', encryptedMessage)
          wsClient.send(JSON.stringify(encryptedMessage))

          this.qrCodeScannedCallbacks.forEach((callback) => callback())
          return
        }

        // Handle encrypted messages
        if (data.method === 'encryptedMessage') {
          // Decode the payload from base64 to Uint8Array
          const payload = new Uint8Array(
            atob(data.params.payload)
              .split('')
              .map((c) => c.charCodeAt(0)),
          )
          try {
            // Decrypt the payload using the shared secret
            const decrypted = await decrypt(payload, this.topicToSharedSecret[topic], topic)
            const decryptedJson: JsonRpcRequest = JSON.parse(decrypted)
            this.handleEncryptedMessage(topic, decryptedJson, data)
          } catch (error) {
            logger.error('Error decrypting message:', error)
          }
          return
        }
      } catch (error) {
        logger.error('Error:', error)
      }
    })
    wsClient.onerror = (error: Event) => {
      logger.error('WebSocket error:', error)
    }
    return this.getZkPassportRequest(topic)
  }

  /**
   * @notice Verifies a proof.
   * @param proof The proof to verify.
   * @returns True if the proof is valid, false otherwise.
   */
  public verify(proof: Proof) {
    const backend = new UltraHonkBackend(proofOfAgeCircuit as CompiledCircuit)
    const proofData: ProofData = {
      proof: Buffer.from(proof.proof, 'hex'),
      publicInputs: proof.publicInputs,
    }
    return backend.verifyProof(proofData)
  }

  /**
   * @notice Returns the URL of the request.
   * @param requestId The request ID.
   * @returns The URL of the request.
   */
  public getUrl(requestId: string) {
    const pubkey = bytesToHex(this.topicToKeyPair[requestId].publicKey)
    return `https://zkpassport.id/r?d=${this.domain}&t=${requestId}&c=${this.topicToConfig[requestId]}&p=${pubkey}`
  }

  /**
   * @notice Cancels a request by closing the WebSocket connection and deleting the associated data.
   * @param requestId The request ID.
   */
  public cancelRequest(requestId: string) {
    this.topicToWebSocketClient[requestId].close()
    delete this.topicToWebSocketClient[requestId]
    delete this.topicToKeyPair[requestId]
    delete this.topicToConfig[requestId]
    delete this.topicToSharedSecret[requestId]
    this.qrCodeScannedCallbacks = []
    this.onGeneratingProofCallbacks = []
    this.onProofGeneratedCallbacks = []
    this.onErrorCallbacks = []
  }
}

const zkPassport = new ZkPassport('https://demo.zkpassport.id')

/*want to check "TUR" is not in the list

find some j where countries[j] < TUR < countries[j+1]

With each letter converted to its ASCII value and the three letters forming a 24 bit number.

Example:
TUR -> 84 117 114
*/

async function main() {
  const queryBuilder = await zkPassport.request({
    keyPairOverride: {
      privateKey: new Uint8Array([
        175, 240, 91, 237, 236, 122, 175, 26, 224, 150, 40, 191, 129, 171, 80, 203, 2, 85, 135, 222, 41, 239, 153, 214,
        94, 222, 43, 145, 55, 168, 230, 253,
      ]),
      publicKey: new Uint8Array([
        2, 211, 255, 94, 93, 183, 196, 140, 52, 136, 11, 193, 30, 139, 69, 122, 75, 154, 107, 242, 162, 245, 69, 207,
        87, 94, 185, 65, 176, 143, 4, 173, 196,
      ]),
    },
    topicOverride: 'abc456',
  })

  const { url, requestId, onQRCodeScanned, onGeneratingProof, onProofGenerated, onReject, onError } = queryBuilder
    .eq('fullname', 'John Doe')
    .range('age', 18, 25)
    .in('nationality', ['USA', 'GBR', 'Germany', 'Canada', 'Portugal'])
    .out('nationality', constants.countries.SANCTIONED)
    .checkAML()
    .done()

  console.log(url)

  onQRCodeScanned(() => {
    logger.info('QR code scanned')
  })

  onGeneratingProof(() => {
    logger.info('Generating proof')
  })

  onProofGenerated((proof) => {
    logger.info('Proof generated', proof)
  })

  onReject(() => {
    logger.info('User rejected')
  })

  onError((error) => {
    logger.error('Error', error)
  })
}

main()
