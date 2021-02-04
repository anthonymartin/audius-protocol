const axios = require('axios')
const FormData = require('form-data')

const SchemaValidator = require('../schemaValidator')

// Currently only supports a single logged-in audius user
class CreatorNode {
  /* Static Utils */

  /**
   * Pulls off the primary creator node from a creator node endpoint string.
   * @param {string} endpoints user.creator_node_endpoint
   */
  static getPrimary (endpoints) { return endpoints ? endpoints.split(',')[0] : '' }

  /**
   * Pulls off the secondary creator nodes from a creator node endpoint string.
   * @param {string} endpoints user.creator_node_endpoint
   */
  static getSecondaries (endpoints) { return endpoints ? endpoints.split(',').slice(1) : [] }

  /**
   * Pulls the user's creator nodes out of the list
   * @param {string} endpoints user.creator_node_endpoint
   */
  static getEndpoints (endpoints) { return endpoints ? endpoints.split(',') : [] }

  /**
   * Builds the creator_node_endpoint value off of a primary and secondaries list
   * @param {string} primary the primary endpoint
   * @param {string[]} secondaries a list of secondary endpoints
   */
  static buildEndpoint (primary, secondaries) {
    return [primary, ...secondaries].join()
  }

  /**
   * Pulls off the user's clock value from a creator node endpoint and the user's wallet address.
   * @param {string} endpoint creator node endpoint
   * @param {string} wallet user wallet address
   */
  static async getClockValue (endpoint, wallet, timeout) {
    try {
      const { data: body } = await axios({
        url: `/users/clock_status/${wallet}`,
        method: 'get',
        baseURL: endpoint,
        timeout
      })
      return body.data.clockValue
    } catch (err) {
      throw new Error(`Failed to get clock value for endpoint: ${endpoint} and wallet: ${wallet} with ${err}`)
    }
  }

  /**
   * Checks if a download is available from provided creator node endpoints
   * @param {string} endpoints creator node endpoints
   * @param {number} trackId
   */
  static async checkIfDownloadAvailable (endpoints, trackId) {
    const primary = CreatorNode.getPrimary(endpoints)
    if (primary) {
      const req = {
        baseURL: primary,
        url: `/tracks/download_status/${trackId}`,
        method: 'get'
      }
      const { data: body } = await axios(req)
      if (body.data.cid) return body.data.cid
    }
    // Download is not available, clients should display "processing"
    return null
  }

  /* -------------- */

  /**
   * Constructs a service class for a creator node
   * @param {Web3Manager} web3Manager
   * @param {string} creatorNodeEndpoint fallback creator node endpoint (to be deprecated)
   * @param {boolean} isServer
   * @param {UserStateManager} userStateManager
   * @param {boolean} lazyConnect whether or not to lazy connect (sign in) on load
   * @param {*} schemas
   * @param {Set<string>?} passList whether or not to include only specified nodes (default null)
   * @param {Set<string>?} blockList whether or not to exclude any nodes (default null)
   * @param {object?} monitoringCallbacks callbacks to be invoked with metrics from requests sent to a service
   *    @param {function} monitoringCallbacks.request
   *    @param {function} monitoringCallbacks.healthCheck
   */
  constructor (
    web3Manager,
    creatorNodeEndpoint,
    isServer,
    userStateManager,
    lazyConnect,
    schemas,
    passList = null,
    blockList = null,
    monitoringCallbacks = null
  ) {
    this.web3Manager = web3Manager
    // This is just 1 endpoint (primary), unlike the creator_node_endpoint field in user metadata
    this.creatorNodeEndpoint = creatorNodeEndpoint
    this.isServer = isServer
    this.userStateManager = userStateManager
    this.schemas = schemas

    this.lazyConnect = lazyConnect
    this.connected = false
    this.connecting = false
    this.authToken = null
    this.maxBlockNumber = 0

    this.passList = passList
    this.blockList = blockList
    this.monitoringCallbacks = monitoringCallbacks
  }

  async init () {
    if (!this.web3Manager) throw new Error('Failed to initialize CreatorNode')
    if (!this.lazyConnect) {
      await this.connect()
    }
  }

  /** Establishes a connection to a creator node endpoint */
  async connect () {
    this.connecting = true
    await this._signupNodeUser(this.web3Manager.getWalletAddress())
    await this._loginNodeUser()
    this.connected = true
    this.connecting = false
  }

  /** Checks if connected, otherwise establishing a connection */
  async ensureConnected () {
    if (!this.connected && !this.connecting) {
      await this.connect()
    } else if (this.connecting) {
      let interval
      // We were already connecting so wait for connection
      await new Promise((resolve, reject) => {
        interval = setInterval(() => {
          if (this.connected) resolve()
        }, 100)
      })
      clearInterval(interval)
    }
  }

  getEndpoint () {
    return this.creatorNodeEndpoint
  }

  async setEndpoint (creatorNodeEndpoint) {
    // If the endpoints are the same, no-op.
    if (this.creatorNodeEndpoint === creatorNodeEndpoint) return

    if (this.connected) {
      try {
        await this._logoutNodeUser()
      } catch (e) {
        console.error(e.message)
      }
    }
    this.connected = false
    this.creatorNodeEndpoint = creatorNodeEndpoint
    if (!this.lazyConnect) {
      await this.connect()
    }
  }

  /**
   * Uploads creator content to a creator node
   * @param {object} metadata the creator metadata
   */
  async uploadCreatorContent (metadata, blockNumber = null) {
    // this does the actual validation before sending to the creator node
    // if validation fails, validate() will throw an error
    try {
      this.schemas[SchemaValidator.userSchemaType].validate(metadata)

      const requestObj = {
        url: '/audius_users/metadata',
        method: 'post',
        data: {
          metadata,
          blockNumber
        }
      }

      const { data: body } = await this._makeRequest(requestObj)
      return body
    } catch (e) {
      console.error('Error validating creator metadata', e)
    }
  }

  /**
   * Creates a creator on the creator node, associating user id with file content
   * @param {number} audiusUserId returned by user creation on-blockchain
   * @param {string} metadataFileUUID unique ID for metadata file
   * @param {number} blockNumber
   */
  async associateCreator (audiusUserId, metadataFileUUID, blockNumber) {
    this.maxBlockNumber = Math.max(this.maxBlockNumber, blockNumber)
    await this._makeRequest({
      url: `/audius_users`,
      method: 'post',
      data: {
        blockchainUserId: audiusUserId,
        metadataFileUUID,
        blockNumber: this.maxBlockNumber
      }
    })
  }

  /**
   * Uploads a track (including audio and image content) to a creator node
   * @param {File} trackFile the audio content
   * @param {File} coverArtFile the image content
   * @param {object} metadata the metadata for the track
   * @param {function?} onProgress an optional on progerss callback
   */
  async uploadTrackContent (trackFile, coverArtFile, metadata, onProgress = () => {}) {
    let loadedImageBytes = 0
    let loadedTrackBytes = 0
    let totalImageBytes = 0
    let totalTrackBytes = 0
    const onImageProgress = (loaded, total) => {
      loadedImageBytes = loaded
      if (!totalImageBytes) totalImageBytes += total
      if (totalImageBytes && totalTrackBytes) {
        onProgress(loadedImageBytes + loadedTrackBytes, totalImageBytes + totalTrackBytes)
      }
    }
    const onTrackProgress = (loaded, total) => {
      loadedTrackBytes = loaded
      if (!totalTrackBytes) totalTrackBytes += total
      if ((!coverArtFile || totalImageBytes) && totalTrackBytes) {
        onProgress(loadedImageBytes + loadedTrackBytes, totalImageBytes + totalTrackBytes)
      }
    }

    let uploadPromises = []
    uploadPromises.push(this.uploadTrackAudio(trackFile, onTrackProgress))
    if (coverArtFile) uploadPromises.push(this.uploadImage(coverArtFile, true, onImageProgress))

    const [trackContentResp, coverArtResp] = await Promise.all(uploadPromises)
    metadata.track_segments = trackContentResp.track_segments
    if (metadata.download && metadata.download.is_downloadable) {
      metadata.download.cid = trackContentResp.transcodedTrackCID
    }

    const sourceFile = trackContentResp.source_file
    if (!sourceFile) {
      throw new Error(`Invalid or missing sourceFile in response: ${JSON.stringify(trackContentResp)}`)
    }

    if (coverArtResp) {
      metadata.cover_art_sizes = coverArtResp.dirCID
    }
    // Creates new track entity on creator node, making track's metadata available on IPFS
    // @returns {Object} {cid: cid of track metadata on IPFS, id: id of track to be used with associate function}
    const metadataResp = await this.uploadTrackMetadata(metadata, sourceFile)
    return { ...metadataResp, ...trackContentResp }
  }

  /**
   * Uploads track metadata to a creator node
   * The metadata object must include a `track_id` field or a
   * source file must be provided (returned from uploading track content).
   * @param {object} metadata
   * @param {string?} sourceFile
   */
  async uploadTrackMetadata (metadata, sourceFile) {
    // this does the actual validation before sending to the creator node
    // if validation fails, validate() will throw an error
    try {
      this.schemas[SchemaValidator.trackSchemaType].validate(metadata)
    } catch (e) {
      console.error('Error validating track metadata', e)
    }

    const { data: body } = await this._makeRequest({
      url: '/tracks/metadata',
      method: 'post',
      data: {
        metadata,
        sourceFile
      }
    }, true)
    return body
  }

  /**
   * Creates a track on the content node, associating track id with file content
   * @param {number} audiusTrackId returned by track creation on-blockchain
   * @param {string} metadataFileUUID unique ID for metadata file
   * @param {number} blockNumber
   * @param {string?} transcodedTrackUUID the CID for the transcoded master if this is a first-time upload
   */
  async associateTrack (audiusTrackId, metadataFileUUID, blockNumber, transcodedTrackUUID) {
    this.maxBlockNumber = Math.max(this.maxBlockNumber, blockNumber)
    await this._makeRequest({
      url: '/tracks',
      method: 'post',
      data: {
        blockchainTrackId: audiusTrackId,
        metadataFileUUID,
        blockNumber: this.maxBlockNumber,
        transcodedTrackUUID
      }
    })
  }

  /**
   * Uploads an image to the connected content node
   * @param {File} file image to upload
   * @param {boolean?} square whether this image should be turned into a square (e.g. profile picture / track artwork)
   * @param {function?} onProgress called with loaded bytes and total bytes
   * @return {Object} response body
   */
  async uploadImage (file, square = true, onProgress) {
    const { data: body } = await this._uploadFile(file, '/image_upload', onProgress, { 'square': square })
    return body
  }

  /**
   * @param {File} file track to upload
   * @param {function?} onProgress called with loaded bytes and total bytes
   * @return {Object} response body
   */
  async uploadTrackAudio (file, onProgress) {
    const { data: body } = await this._uploadFile(file, '/track_content', onProgress)
    return body
  }

  /**
   * Gets all unlisted track for a user.
   * Will only return tracks for the currently authed user.
   *
   * @returns {(Array)} tracks array of tracks
   */
  async getUnlistedTracks () {
    const request = {
      url: 'tracks/unlisted',
      method: 'get'
    }
    const { data: body } = await this._makeRequest(request)
    return body.tracks
  }

  /**
   * Given a particular endpoint to a creator node, check whether
   * this user has a sync in progress on that node.
   * @param {string} endpoint
   * @param {number?} timeout ms
   */
  async getSyncStatus (endpoint, timeout = null) {
    const user = this.userStateManager.getCurrentUser()
    if (user) {
      const req = {
        baseURL: endpoint,
        url: `/sync_status/${user.wallet}`,
        method: 'get'
      }
      if (timeout) req.timeout = timeout
      const { data: body } = await axios(req)
      const status = body.data
      return {
        status,
        userBlockNumber: user.blocknumber,
        trackBlockNumber: user.track_blocknumber,
        // Whether or not the endpoint is behind in syncing
        isBehind: status.latestBlockNumber < Math.max(user.blocknumber, user.track_blocknumber),
        isConfigured: status.latestBlockNumber !== -1
      }
    }
    throw new Error(`No current user`)
  }

  /**
   * Syncs a secondary creator node for a given user
   * @param {string} secondary
   * @param {string} primary specific primary to use
   * @param {boolean} immediate whether or not this is a blocking request and handled right away
   * @param {boolean} validate whether or not to validate the provided secondary is valid
   */
  async syncSecondary (
    secondary,
    primary = null,
    immediate = false,
    validate = true
  ) {
    const user = this.userStateManager.getCurrentUser()
    if (!primary) {
      primary = CreatorNode.getPrimary(user.creator_node_endpoint)
    }
    const secondaries = new Set(CreatorNode.getSecondaries(user.creator_node_endpoint))
    if (primary && secondary && (!validate || secondaries.has(secondary))) {
      const req = {
        baseURL: secondary,
        url: '/sync',
        method: 'post',
        data: {
          wallet: [user.wallet],
          creator_node_endpoint: primary,
          immediate
        }
      }
      return axios(req)
    }
  }

  /* ------- INTERNAL FUNCTIONS ------- */

  /**
   * Signs up a creator node user with a wallet address
   * @param {string} walletAddress
   */
  async _signupNodeUser (walletAddress) {
    await this._makeRequest({
      url: '/users',
      method: 'post',
      data: { walletAddress }
    }, false)
  }

  /**
   * Logs user into cnode, if not already logged in.
   * Requests a challenge from cnode, sends signed challenge response to cn.
   * If successful, receive and set authToken locally.
   */
  async _loginNodeUser () {
    if (this.authToken) {
      return
    }

    let walletPublicKey = this.web3Manager.getWalletAddress()
    let clientChallengeKey
    let url

    try {
      let challengeResp = await this._makeRequest({
        url: '/users/login/challenge',
        method: 'get',
        params: {
          walletPublicKey
        }
      }, false)

      clientChallengeKey = challengeResp.data.challenge
      url = '/users/login/challenge'
    } catch (e) {
      // If '/users/login/get_challenge' returns 404, login using legacy non-challenge route
      if (e.response && e.response.status === 404) {
        clientChallengeKey = Math.round((new Date()).getTime() / 1000)
        url = '/users/login'
      } else {
        const requestUrl = this.creatorNodeEndpoint + '/users/login/challenge'
        _handleErrorHelper(e, requestUrl)
      }
    }

    const signature = await this.web3Manager.sign(clientChallengeKey)

    const resp = await this._makeRequest({
      url,
      method: 'post',
      data: {
        data: clientChallengeKey,
        signature
      }
    }, false)
    this.authToken = resp.data.sessionToken
  }

  async _logoutNodeUser () {
    if (!this.authToken) {
      return
    }
    await this._makeRequest({
      url: '/users/logout',
      method: 'post'
    }, false)
    this.authToken = null
  }

  /**
   * Gets and returns the clock values across the replica set for the wallet in userStateManager.
   * @returns {Object[]} Array of objects with the structure:
   *
   * {
   *  type: 'primary' or 'secondary',
   *  endpoint: <Content Node endpoint>,
   *  clockValue: clock value (should be an integer) or null
   * }
   *
   * 'clockValue' may be null if the request to fetch the clock value fails
   */
  async getClockValuesFromReplicaSet () {
    const user = this.userStateManager.getCurrentUser()
    if (!user || !user.creator_node_endpoint) {
      console.error('No user or Content Node endpoint found')
      return
    }

    const replicaSet = CreatorNode.getEndpoints(user.creator_node_endpoint)
    const clockValueResponses = await Promise.all(
      replicaSet.map(endpoint => this._clockValueRequest({ user, endpoint }))
    )

    return clockValueResponses
  }

  /**
   * Wrapper around getClockValue() to return either a proper or null clock value
   * @param {Object} param
   * @param {Object} param.user user metadata object from userStateManager
   * @param {string} param.endpoint the Content Node endpoint to check the clock value for
   */
  async _clockValueRequest ({ user, endpoint, timeout = 1000 }) {
    const primary = CreatorNode.getPrimary(user.creator_node_endpoint)
    let type = primary === endpoint ? 'primary' : 'secondary'

    try {
      const clockValue = await CreatorNode.getClockValue(endpoint, user.wallet, timeout)
      return {
        type,
        endpoint,
        clockValue
      }
    } catch (e) {
      console.error(`Error in getting clock status for ${user.wallet} at ${endpoint}: ${e}`)
      return {
        type,
        endpoint,
        clockValue: null
      }
    }
  }

  /**
   * Makes an axios request to the connected creator node.
   * @param {Object} axiosRequestObj
   * @param {bool} requiresConnection if set, the currently configured creator node
   * is connected to before the request is made.
   * @return {Object} response body
   */
  async _makeRequest (axiosRequestObj, requiresConnection = true) {
    if (requiresConnection) {
      await this.ensureConnected()
    }

    axiosRequestObj.headers = axiosRequestObj.headers || {}

    if (this.authToken) {
      axiosRequestObj.headers['X-Session-ID'] = this.authToken
    }

    const user = this.userStateManager.getCurrentUser()
    if (user && user.wallet && user.user_id) {
      axiosRequestObj.headers['User-Wallet-Addr'] = user.wallet
      axiosRequestObj.headers['User-Id'] = user.user_id
    }

    axiosRequestObj.baseURL = this.creatorNodeEndpoint

    // Axios throws for non-200 responses
    try {
      const start = Date.now()
      const resp = await axios(axiosRequestObj)
      const duration = Date.now() - start

      if (this.monitoringCallbacks.request) {
        this.monitoringCallbacks.request({
          endpoint: axiosRequestObj.baseURL,
          pathname: axiosRequestObj.url,
          signer: resp.data.signer,
          signature: resp.data.signature,
          requestMethod: axiosRequestObj.method,
          status: resp.status,
          responseTimeMillis: duration
        })
      }
      // Axios `data` field gets the response body
      return resp.data
    } catch (e) {
      _handleErrorHelper(e, axiosRequestObj.url)
    }
  }

  /**
   * Uploads a file to the connected creator node.
   * @param {File} file
   * @param {string} route route to handle upload (image_upload, track_upload, etc.)
   * @param {function?} onProgress called with loaded bytes and total bytes
   * @param {Object<string, any>} extraFormDataOptions extra FormData fields passed to the upload
   */
  async _uploadFile (file, route, onProgress = (loaded, total) => {}, extraFormDataOptions = {}) {
    await this.ensureConnected()

    // form data is from browser, not imported npm module
    let formData = new FormData()
    formData.append('file', file)
    Object.keys(extraFormDataOptions).forEach(key => {
      formData.append(key, extraFormDataOptions[key])
    })

    let headers = {}
    if (this.isServer) {
      headers = formData.getHeaders()
    }
    headers['X-Session-ID'] = this.authToken

    let total
    const url = this.creatorNodeEndpoint + route
    try {
      // Hack alert!
      //
      // Axios auto-detects browser vs node based on
      // the existance of XMLHttpRequest at the global namespace, which
      // is imported by a web3 module, causing Axios to incorrectly
      // presume we're in a browser env when we're in a node env.
      // For uploads to work in a node env,
      // axios needs to correctly detect we're in node and use the `http` module
      // rather than XMLHttpRequest. We force that here.
      // https://github.com/axios/axios/issues/1180
      const isBrowser = typeof window !== 'undefined'
      console.debug(`Uploading file to ${url}`)
      const resp = await axios.post(
        url,
        formData,
        {
          headers: headers,
          adapter: isBrowser ? require('axios/lib/adapters/xhr') : require('axios/lib/adapters/http'),
          // Add a 10% inherit processing time for the file upload.
          onUploadProgress: (progressEvent) => {
            if (!total) total = progressEvent.total
            onProgress(progressEvent.loaded, total)
          }
        }
      )
      if (resp.data && resp.data.error) {
        throw new Error(resp.data.error)
      }
      onProgress(total, total)
      return resp.data
    } catch (e) {
      _handleErrorHelper(e, url)
    }
  }
}

function _handleErrorHelper (e, requestUrl) {
  if (e.response && e.response.data && e.response.data.error) {
    const cnRequestID = e.response.headers['cn-request-id']
    const errMessage = `Server returned error: [${e.response.status.toString()}] [${e.response.data.error}] for request: [${cnRequestID}]`

    console.error(errMessage)
    throw new Error(errMessage)
  } else if (!e.response) {
    // delete headers, may contain tokens
    if (e.config && e.config.headers) delete e.config.headers

    const errorMsg = `Network error while making request to ${requestUrl}:\nStringified Error:${JSON.stringify(e)}\n`
    console.error(errorMsg, e)
    throw new Error(`${errorMsg}${e}`)
  } else {
    throw e
  }
}

module.exports = CreatorNode
