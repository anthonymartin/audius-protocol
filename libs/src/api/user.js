const { pick } = require('lodash')
const { Base, Services } = require('./base')
const Utils = require('../utils')
const CreatorNode = require('../services/creatorNode')

// User metadata fields that are required on the metadata object and can have
// null or non-null values
const USER_PROPS = [
  'is_creator',
  'is_verified',
  'name',
  'handle',
  'profile_picture',
  'profile_picture_sizes',
  'cover_photo',
  'cover_photo_sizes',
  'bio',
  'location',
  'creator_node_endpoint'
]
// User metadata fields that are required on the metadata object and only can have
// non-null values
const USER_REQUIRED_PROPS = [
  'name',
  'handle'
]
// Constants for user metadata fields
const USER_PROP_NAME_CONSTANTS = Object.freeze({
  NAME: 'name',
  IS_CREATOR: 'is_creator',
  BIO: 'bio',
  LOCATION: 'location',
  PROFILE_PICTURE_SIZES: 'profile_picture_sizes',
  COVER_PHOTO_SIZES: 'cover_photo_sizes',
  CREATOR_NODE_ENDPOINT: 'creator_node_endpoint'
})

class Users extends Base {
  constructor (serviceProvider, ...args) {
    super(...args)

    this.ServiceProvider = serviceProvider

    this.getUsers = this.getUsers.bind(this)
    this.getMutualFollowers = this.getMutualFollowers.bind(this)
    this.getFollowersForUser = this.getFollowersForUser.bind(this)
    this.getFolloweesForUser = this.getFolloweesForUser.bind(this)
    this.getUserRepostFeed = this.getUserRepostFeed.bind(this)
    this.getSocialFeed = this.getSocialFeed.bind(this)
    this.getTopCreatorsByGenres = this.getTopCreatorsByGenres.bind(this)
    this.uploadProfileImages = this.uploadProfileImages.bind(this)
    this.addUser = this.addUser.bind(this)
    this.updateUser = this.updateUser.bind(this)
    this.updateCreator = this.updateCreator.bind(this)
    this.upgradeToCreator = this.upgradeToCreator.bind(this)
    this.updateIsVerified = this.updateIsVerified.bind(this)
    this.addUserFollow = this.addUserFollow.bind(this)
    this.deleteUserFollow = this.deleteUserFollow.bind(this)

    // For adding replica set to users on sign up
    this.assignReplicaSet = this.assignReplicaSet.bind(this)

    this.getClockValuesFromReplicaSet = this.getClockValuesFromReplicaSet.bind(this)
    this._waitForCreatorNodeEndpointIndexing = this._waitForCreatorNodeEndpointIndexing.bind(this)
    this._addUserOperations = this._addUserOperations.bind(this)
    this._updateUserOperations = this._updateUserOperations.bind(this)
    this._validateUserMetadata = this._validateUserMetadata.bind(this)
    this._cleanUserMetadata = this._cleanUserMetadata.bind(this)
  }

  /* ----------- GETTERS ---------- */

  /**
   * get users with all relevant user data
   * can be filtered by providing an integer array of ids
   * @param {number} limit
   * @param {number} offset
   * @param {Object} idsArray
   * @param {String} walletAddress
   * @param {String} handle
   * @param {Boolean} isCreator null returns all users, true returns creators only, false returns users only
   * @param {number} currentUserId the currently logged in user
   * @returns {Object} {Array of User metadata Objects}
   * additional metadata fields on user objects:
   *  {Integer} track_count - track count for given user
   *  {Integer} playlist_count - playlist count for given user
   *  {Integer} album_count - album count for given user
   *  {Integer} follower_count - follower count for given user
   *  {Integer} followee_count - followee count for given user
   *  {Integer} repost_count - repost count for given user
   *  {Integer} track_blocknumber - blocknumber of latest track for user
   *  {Boolean} does_current_user_follow - does current user follow given user
   *  {Array} followee_follows - followees of current user that follow given user
   * @example
   * await getUsers()
   * await getUsers(100, 0, [3,2,6]) - Invalid user ids will not be accepted
   */
  async getUsers (limit = 100, offset = 0, idsArray = null, walletAddress = null, handle = null, isCreator = null, minBlockNumber = null) {
    this.REQUIRES(Services.DISCOVERY_PROVIDER)
    return this.discoveryProvider.getUsers(limit, offset, idsArray, walletAddress, handle, isCreator, minBlockNumber)
  }

  /**
   * get intersection of users that follow followeeUserId and users that are followed by followerUserId
   * @param {number} followeeUserId user that is followed
   * @example
   * getMutualFollowers(100, 0, 1, 1) - IDs must be valid
   */
  async getMutualFollowers (limit = 100, offset = 0, followeeUserId) {
    this.REQUIRES(Services.DISCOVERY_PROVIDER)
    const followerUserId = this.userStateManager.getCurrentUserId()
    if (followerUserId) {
      return this.discoveryProvider.getFollowIntersectionUsers(limit, offset, followeeUserId, followerUserId)
    }
    return []
  }

  /**
   * get users that follow followeeUserId, sorted by follower count descending
   * @param {number} currentUserId the currently logged in user
   * @param {number} followeeUserId user that is followed
   * @return {Array} array of user objects with standard user metadata
   */
  async getFollowersForUser (limit = 100, offset = 0, followeeUserId) {
    this.REQUIRES(Services.DISCOVERY_PROVIDER)
    return this.discoveryProvider.getFollowersForUser(limit, offset, followeeUserId)
  }

  /**
   * get users that are followed by followerUserId, sorted by follower count descending
   * @param {number} currentUserId the currently logged in user
   * @param {number} followerUserId user - i am the one who follows
   * @return {Array} array of user objects with standard user metadata
   */
  async getFolloweesForUser (limit = 100, offset = 0, followerUserId) {
    this.REQUIRES(Services.DISCOVERY_PROVIDER)
    return this.discoveryProvider.getFolloweesForUser(limit, offset, followerUserId)
  }

  /**
   * Return repost feed for requested user
   * @param {number} userId - requested user id
   * @param {filter} string - filter by "all", "original", or "repost"
   * @param {number} limit - max # of items to return (for pagination)
   * @param {number} offset - offset into list to return from (for pagination)
   * @returns {Object} {Array of track and playlist metadata objects}
   * additional metadata fields on track and playlist objects:
   *  {String} activity_timestamp - timestamp of requested user's repost for given track or playlist,
   *    used for sorting feed
   *  {Integer} repost_count - repost count of given track/playlist
   *  {Integer} save_count - save count of given track/playlist
   *  {Boolean} has_current_user_reposted - has current user reposted given track/playlist
   *  {Array} followee_reposts - followees of current user that have reposted given track/playlist
   */
  async getUserRepostFeed (userId, filter, limit = 100, offset = 0, withUsers = false) {
    this.REQUIRES(Services.DISCOVERY_PROVIDER)
    return this.discoveryProvider.getUserRepostFeed(userId, filter, limit, offset, withUsers)
  }

  /**
   * Return social feed for current user
   * @param {number} limit - max # of items to return
   * @param {filter} string - filter by "all", "original", or "repost"
   * @param {number} offset - offset into list to return from (for pagination)
   * @returns {Object} {Array of track and playlist metadata objects}
   * additional metadata fields on track and playlist objects:
   *  {String} activity_timestamp - timestamp of requested user's repost for given track or playlist,
   *    used for sorting feed
   *  {Integer} repost_count - repost count of given track/playlist
   *  {Integer} save_count - save count of given track/playlist
   *  {Boolean} has_current_user_reposted - has current user reposted given track/playlist
   *  {Array} followee_reposts - followees of current user that have reposted given track/playlist
   */
  async getSocialFeed (filter, limit = 100, offset = 0, withUsers = false, tracksOnly = false) {
    this.REQUIRES(Services.DISCOVERY_PROVIDER)
    const owner = this.userStateManager.getCurrentUser()
    if (owner) {
      return this.discoveryProvider.getSocialFeed(filter, limit, offset, withUsers, tracksOnly)
    }

    return []
  }

  /**
   * Returns the top users for the specified genres
   * @param {number} limit - max # of items to return
   * @param {number} offset - offset into list to return from (for pagination)
   * @param {Object} {Array of genres} - filter by genres ie. "Rock", "Alternative"
   * @param {Boolean} with_users - If the userIds should be returned or the full user metadata
   * @returns {Object} {Array of user objects if with_users set, else array of userIds}
   */
  async getTopCreatorsByGenres (genres, limit = 30, offset = 0, withUsers = false) {
    this.REQUIRES(Services.DISCOVERY_PROVIDER)
    return this.discoveryProvider.getTopCreatorsByGenres(genres, limit, offset, withUsers)
  }

  /* ------- SETTERS ------- */

  /**
   * Assigns a replica set to the user's metadata and adds new metadata to chain.
   * This creates a record for that user on the connected creator node.
   * @param {Object} param
   * @param {number} param.userId
   */
  async assignReplicaSet ({
    userId
  }) {
    this.REQUIRES(Services.CREATOR_NODE)
    const phases = {
      CLEAN_AND_VALIDATE_METADATA: 'CLEAN_AND_VALIDATE_METADATA',
      AUTOSELECT_CONTENT_NODES: 'AUTOSELECT_CONTENT_NODES',
      SYNC_ACROSS_CONTENT_NODES: 'SYNC_ACROSS_CONTENT_NODES',
      SET_PRIMARY: 'SET_PRIMARY',
      UPLOAD_METADATA_AND_UPDATE_ON_CHAIN: 'UPLOAD_METADATA_AND_UPDATE_ON_CHAIN'
    }
    let phase = ''

    const user = this.userStateManager.getCurrentUser()
    // Failed the addUser() step
    if (!user) { throw new Error('No current user') }
    // No-op if the user already has a replica set assigned under creator_node_endpoint
    if (user.creator_node_endpoint && user.creator_node_endpoint.length > 0) return

    // The new metadata object that will contain the replica set
    const newMetadata = { ...user }
    try {
      // Create starter metadata and validate
      phase = phases.CLEAN_AND_VALIDATE_METADATA

      // Autoselect a new replica set and update the metadata object with new content node endpoints
      phase = phases.AUTOSELECT_CONTENT_NODES
      const response = await this.ServiceProvider.autoSelectCreatorNodes({
        performSyncCheck: false
      })
      // Ideally, 1 primary and n-1 secondaries are chosen. The best-worst case scenario is that at least 1 primary
      // is chosen. If a primary was not selected (which also implies that secondaries were not chosen), throw
      // an error.
      const { primary, secondaries } = response
      if (!primary) {
        throw new Error(`Could not select a primary.`)
      }

      const newContentNodeEndpoints = CreatorNode.buildEndpoint(primary, secondaries)
      newMetadata.creator_node_endpoint = newContentNodeEndpoints

      // Update the new primary to the auto-selected primary
      phase = phases.SET_PRIMARY
      await this.creatorNode.setEndpoint(primary)

      // Update metadata in CN and on chain of newly assigned replica set
      phase = phases.UPLOAD_METADATA_AND_UPDATE_ON_CHAIN
      await this.updateAndUploadMetadata({
        newMetadata,
        userId
      })
    } catch (e) {
      console.log(`assignReplicaSet() Error -- Phase ${phase}: ${e}`)
      throw new Error(`assignReplicaSet() Error -- Phase ${phase}: ${e}`)
    }

    return newMetadata
  }

  /**
   * Util to upload profile picture and cover photo images and update
   * a metadata object. This method inherently calls triggerSecondarySyncs().
   * @param {?File} profilePictureFile an optional file to upload as the profile picture
   * @param {?File} coverPhotoFile an optional file to upload as the cover phtoo
   * @param {Object} metadata to update
   * @returns {Object} the passed in metadata object with profile_picture and cover_photo fields added
   */
  async uploadProfileImages (profilePictureFile, coverPhotoFile, metadata) {
    let didMetadataUpdate = false
    if (profilePictureFile) {
      const resp = await this.creatorNode.uploadImage(profilePictureFile, true)
      metadata.profile_picture_sizes = resp.dirCID
      didMetadataUpdate = true
    }
    if (coverPhotoFile) {
      const resp = await this.creatorNode.uploadImage(coverPhotoFile, false)
      metadata.cover_photo_sizes = resp.dirCID
      didMetadataUpdate = true
    }

    if (didMetadataUpdate) {
      await this.updateAndUploadMetadata({
        newMetadata: metadata,
        userId: metadata.user_id
      })
    }

    return metadata
  }

  /**
   * Create an on-chain non-creator user. Some fields are restricted (ex.
   * creator_node_endpoint); this should error if the metadata given attempts to set them.
   * @param {Object} metadata metadata to associate with the user
   */
  async addUser (metadata) {
    this.IS_OBJECT(metadata)
    const newMetadata = this._cleanUserMetadata(metadata)
    this._validateUserMetadata(newMetadata)

    let userId
    const currentUser = this.userStateManager.getCurrentUser()
    if (currentUser && currentUser.handle) {
      userId = currentUser.user_id
    } else {
      userId = (await this.contracts.UserFactoryClient.addUser(newMetadata.handle)).userId
    }
    await this._addUserOperations(userId, newMetadata)

    newMetadata.wallet = this.web3Manager.getWalletAddress()
    newMetadata.user_id = userId

    this.userStateManager.setCurrentUser({ ...newMetadata })
    return userId
  }

  /**
   * Updates a user
   * @param {number} userId
   * @param {Object} metadata
   */
  async updateUser (userId, metadata) {
    this.REQUIRES(Services.DISCOVERY_PROVIDER)
    this.IS_OBJECT(metadata)
    const newMetadata = this._cleanUserMetadata(metadata)
    this._validateUserMetadata(newMetadata)

    // Retrieve the current user metadata
    let users = await this.discoveryProvider.getUsers(1, 0, [userId], null, null, false, null)
    if (!users || !users[0]) throw new Error(`Cannot update user because no current record exists for user id ${userId}`)

    const oldMetadata = users[0]
    await this._updateUserOperations(newMetadata, oldMetadata, userId)
    this.userStateManager.setCurrentUser({ ...oldMetadata, ...newMetadata })
  }

  /**
   * Updates a creator (updates their data on the creator node)
   * @param {number} userId
   * @param {Object} metadata
   */
  async updateCreator (userId, metadata) {
    this.REQUIRES(Services.CREATOR_NODE, Services.DISCOVERY_PROVIDER)
    this.IS_OBJECT(metadata)
    const newMetadata = this._cleanUserMetadata(metadata)
    this._validateUserMetadata(newMetadata)

    // Error if libs instance does not already have existing user state
    const user = this.userStateManager.getCurrentUser()
    if (!user) {
      throw new Error('No current user')
    }

    // Ensure libs is connected to correct CN
    if (this.creatorNode.getEndpoint() !== CreatorNode.getPrimary(newMetadata['creator_node_endpoint'])) {
      throw new Error(`Not connected to correct content node. Expected ${CreatorNode.getPrimary(newMetadata['creator_node_endpoint'])}, got ${this.creatorNode.getEndpoint()}`)
    }

    // Preserve old metadata object
    const oldMetadata = { ...user }

    // Update user creator_node_endpoint on chain if applicable
    let updateEndpointTxBlockNumber = null
    if (newMetadata.creator_node_endpoint !== oldMetadata.creator_node_endpoint) {
      const { txReceipt: updateEndpointTxReceipt } = await this.contracts.UserFactoryClient.updateCreatorNodeEndpoint(userId, newMetadata['creator_node_endpoint'])
      updateEndpointTxBlockNumber = updateEndpointTxReceipt.blockNumber

      // Ensure DN has indexed creator_node_endpoint change
      await this._waitForCreatorNodeEndpointIndexing(newMetadata.user_id, newMetadata.creator_node_endpoint)
    }

    // Upload new metadata object to CN
    const { metadataMultihash, metadataFileUUID } = await this.creatorNode.uploadCreatorContent(newMetadata, updateEndpointTxBlockNumber)

    // Write metadata multihash to chain
    const updatedMultihashDecoded = Utils.decodeMultihash(metadataMultihash)
    const { txReceipt } = await this.contracts.UserFactoryClient.updateMultihash(userId, updatedMultihashDecoded.digest)

    // Write remaining metadata fields to chain
    const { latestBlockNumber } = await this._updateUserOperations(newMetadata, oldMetadata, userId, ['creator_node_endpoint'])

    // Write to CN to associate blockchain user id with updated metadata and block number
    await this.creatorNode.associateCreator(userId, metadataFileUUID, Math.max(txReceipt.blockNumber, latestBlockNumber))

    // Update libs instance with new user metadata object
    this.userStateManager.setCurrentUser({ ...oldMetadata, ...newMetadata })

    return userId
  }

  /**
   * Upgrades a user to a creator using their metadata object.
   * This creates a record for that user on the connected creator node.
   * @param {string} existingEndpoint
   * @param {string} newCreatorNodeEndpoint comma delineated
   */
  async upgradeToCreator (existingEndpoint, newCreatorNodeEndpoint) {
    this.REQUIRES(Services.CREATOR_NODE)

    // Error if libs instance does not already have existing user state
    const user = this.userStateManager.getCurrentUser()
    if (!user) {
      throw new Error('No current user')
    }

    // No-op if the user is already a creator.
    // Consider them a creator iff they have is_creator=true AND a creator node endpoint
    if (user.is_creator && user.creator_node_endpoint) return

    const userId = user.user_id
    const oldMetadata = { ...user }

    // Clean and validate metadata
    const newMetadata = this._cleanUserMetadata({ ...user })
    this._validateUserMetadata(newMetadata)

    // Populate metadata with required fields - wallet, is_creator, creator_node_endpoint
    newMetadata.wallet = this.web3Manager.getWalletAddress()
    newMetadata.is_creator = true

    let updateEndpointTxBlockNumber = null

    /**
     * If there is no creator_node_endpoint field or if newCreatorNodeEndpoint is not the same as the existing
     * metadata creator_node_endpoint field value, update the field with newCreatorNodeEndpoint.
     * This is because new users on signup will now be assigned a replica set, and do not need to
     * be assigned a new one via newCreatorNodeEndpoint.
     */
    if (
      !oldMetadata.creator_node_endpoint ||
      oldMetadata.creator_node_endpoint !== newCreatorNodeEndpoint
    ) {
      newMetadata.creator_node_endpoint = newCreatorNodeEndpoint
      const newPrimary = CreatorNode.getPrimary(newCreatorNodeEndpoint)

      // Sync user data from old primary to new endpoint
      if (existingEndpoint) {
        // Don't validate what we're syncing from because the user isn't
        // a creator yet.
        await this.creatorNode.syncSecondary(
          newPrimary,
          existingEndpoint,
          /* immediate= */ true,
          /* validate= */ false
        )
      }

      // Update local libs state with new CN endpoint
      await this.creatorNode.setEndpoint(newPrimary)

      // Update user creator_node_endpoint on chain if applicable
      const { txReceipt: updateEndpointTxReceipt } = await this.contracts.UserFactoryClient.updateCreatorNodeEndpoint(userId, newMetadata['creator_node_endpoint'])
      updateEndpointTxBlockNumber = updateEndpointTxReceipt.blockNumber

      // Ensure DN has indexed creator_node_endpoint change
      await this._waitForCreatorNodeEndpointIndexing(newMetadata.user_id, newMetadata.creator_node_endpoint)
    }

    // Upload new metadata object to CN
    const { metadataMultihash, metadataFileUUID } = await this.creatorNode.uploadCreatorContent(newMetadata, updateEndpointTxBlockNumber)

    // Write metadata multihash to chain
    const updatedMultihashDecoded = Utils.decodeMultihash(metadataMultihash)
    const { txReceipt } = await this.contracts.UserFactoryClient.updateMultihash(userId, updatedMultihashDecoded.digest)

    // Write remaining metadata fields to chain
    const { latestBlockNumber } = await this._updateUserOperations(newMetadata, oldMetadata, userId, ['creator_node_endpoint'])

    // Write to CN to associate blockchain user id with updated metadata and block number
    await this.creatorNode.associateCreator(userId, metadataFileUUID, Math.max(txReceipt.blockNumber, latestBlockNumber))

    // Update libs instance with new user metadata object
    this.userStateManager.setCurrentUser({ ...oldMetadata, ...newMetadata })

    return userId
  }

  /**
   * Updates a user on whether they are verified on Audius
   * @param {number} userId
   * @param {boolean} isVerified
   */
  async updateIsVerified (userId, isVerified, privateKey) {
    return this.contracts.UserFactoryClient.updateIsVerified(userId, isVerified, privateKey)
  }

  /**
   * Adds a user follow for a given follower and followee
   * @param {number} followerUserId who is following
   * @param {number} followeeUserId who is being followed...
  */
  async addUserFollow (followeeUserId) {
    const followerUserId = this.userStateManager.getCurrentUserId()
    return this.contracts.SocialFeatureFactoryClient.addUserFollow(followerUserId, followeeUserId)
  }

  /**
   * Deletes a user follow for a given follower and followee
   * @param {number} followerUserId who is no longer following
   * @param {number} followeeUserId who is no longer being followed...
  */
  async deleteUserFollow (followeeUserId) {
    const followerUserId = this.userStateManager.getCurrentUserId()
    return this.contracts.SocialFeatureFactoryClient.deleteUserFollow(followerUserId, followeeUserId)
  }

  /**
   * Gets the clock status for user in userStateManager across replica set.
   */
  async getClockValuesFromReplicaSet () {
    return this.creatorNode.getClockValuesFromReplicaSet()
  }

  /* ------- PRIVATE  ------- */

  /**
   * 1. Uploads metadata to primary Content Node (which inherently calls a sync accross secondaries)
   * 2. Updates metadata on chain
   * @param {Object} param
   * @param {Object} param.newMetadata new metadata object
   * @param {number} param.userId
   */
  async updateAndUploadMetadata ({ newMetadata, userId }) {
    this.REQUIRES(Services.CREATOR_NODE, Services.DISCOVERY_PROVIDER)
    this.IS_OBJECT(newMetadata)
    const phases = {
      UPDATE_CONTENT_NODE_ENDPOINT_ON_CHAIN: 'UPDATE_CONTENT_NODE_ENDPOINT_ON_CHAIN',
      UPLOAD_METADATA: 'UPLOAD_METADATA',
      UPDATE_METADATA_ON_CHAIN: 'UPDATE_METADATA_ON_CHAIN',
      ASSOCIATE_USER: 'ASSOCIATE_USER'
    }
    let phase = ''

    const oldMetadata = this.userStateManager.getCurrentUser()
    if (!oldMetadata) { throw new Error('No current user.') }

    newMetadata = this._cleanUserMetadata(newMetadata)
    this._validateUserMetadata(newMetadata)

    try {
      // Update user creator_node_endpoint on chain if applicable
      if (newMetadata.creator_node_endpoint !== oldMetadata.creator_node_endpoint) {
        phase = phases.UPDATE_CONTENT_NODE_ENDPOINT_ON_CHAIN
        await this.contracts.UserFactoryClient.updateCreatorNodeEndpoint(userId, newMetadata['creator_node_endpoint'])
        // Ensure DN has indexed creator_node_endpoint change
        await this._waitForCreatorNodeEndpointIndexing(userId, newMetadata.creator_node_endpoint)
      }

      // Upload new metadata object to CN
      phase = phases.UPLOAD_METADATA
      const { metadataMultihash, metadataFileUUID } = await this.creatorNode.uploadCreatorContent(newMetadata)

      // Write metadata multihash to chain
      phase = phases.UPDATE_METADATA_ON_CHAIN
      const updatedMultihashDecoded = Utils.decodeMultihash(metadataMultihash)
      const { txReceipt } = await this.contracts.UserFactoryClient.updateMultihash(userId, updatedMultihashDecoded.digest)

      // Write remaining metadata fields to chain
      const { latestBlockNumber } = await this._updateUserOperations(newMetadata, oldMetadata, userId, ['creator_node_endpoint'])

      // Write to CN to associate blockchain user id with updated metadata and block number
      phase = phases.ASSOCIATE_USER
      await this.creatorNode.associateCreator(userId, metadataFileUUID, Math.max(txReceipt.blockNumber, latestBlockNumber))

      // Update libs instance with new user metadata object
      this.userStateManager.setCurrentUser({ ...oldMetadata, ...newMetadata })
    } catch (e) {
      // TODO: think about handling the update metadata on chain and associating..
      throw new Error(`updateAndUploadMetadata() Error -- Phase ${phase}: ${e}`)
    }
  }

  /** Waits for a discovery provider to confirm that a creator node endpoint is updated. */
  async _waitForCreatorNodeEndpointIndexing (userId, creatorNodeEndpoint) {
    let isUpdated = false
    while (!isUpdated) {
      const userList = await this.discoveryProvider.getUsers(1, 0, [userId])
      if (userList) {
        const user = userList[0]
        if (user && user.creator_node_endpoint === creatorNodeEndpoint) isUpdated = true
      }
      await Utils.wait(500)
    }
  }

  async _addUserOperations (userId, newMetadata, exclude = []) {
    let addOps = []

    // Remove excluded keys from metadata object
    let metadata = { ...newMetadata }
    exclude.map(excludedKey => delete metadata[excludedKey])

    if (metadata[USER_PROP_NAME_CONSTANTS.NAME]) {
      addOps.push(this.contracts.UserFactoryClient.updateName(userId, metadata[USER_PROP_NAME_CONSTANTS.NAME]))
    }
    if (metadata[USER_PROP_NAME_CONSTANTS.LOCATION]) {
      addOps.push(this.contracts.UserFactoryClient.updateLocation(userId, metadata[USER_PROP_NAME_CONSTANTS.LOCATION]))
    }
    if (metadata[USER_PROP_NAME_CONSTANTS.BIO]) {
      addOps.push(this.contracts.UserFactoryClient.updateBio(userId, metadata[USER_PROP_NAME_CONSTANTS.BIO]))
    }
    if (metadata[USER_PROP_NAME_CONSTANTS.PROFILE_PICTURE_SIZES]) {
      addOps.push(this.contracts.UserFactoryClient.updateProfilePhoto(
        userId,
        Utils.decodeMultihash(metadata[USER_PROP_NAME_CONSTANTS.PROFILE_PICTURE_SIZES]).digest
      ))
    }
    if (metadata[USER_PROP_NAME_CONSTANTS.COVER_PHOTO_SIZES]) {
      addOps.push(this.contracts.UserFactoryClient.updateCoverPhoto(
        userId,
        Utils.decodeMultihash(metadata[USER_PROP_NAME_CONSTANTS.COVER_PHOTO_SIZES]).digest
      ))
    }
    if (metadata[USER_PROP_NAME_CONSTANTS.IS_CREATOR]) {
      addOps.push(this.contracts.UserFactoryClient.updateIsCreator(userId, metadata[USER_PROP_NAME_CONSTANTS.IS_CREATOR]))
    }
    if (metadata[USER_PROP_NAME_CONSTANTS.CREATOR_NODE_ENDPOINT]) {
      addOps.push(this.contracts.UserFactoryClient.updateCreatorNodeEndpoint(userId, metadata[USER_PROP_NAME_CONSTANTS.CREATOR_NODE_ENDPOINT]))
    }

    // Execute update promises concurrently
    // TODO - what if one or more of these fails?
    const ops = await Promise.all(addOps)
    return { ops: ops, latestBlockNumber: Math.max(...ops.map(op => op.txReceipt.blockNumber)) }
  }

  async _updateUserOperations (newMetadata, currentMetadata, userId, exclude = []) {
    let updateOps = []

    // Remove excluded keys from metadata object
    let metadata = { ...newMetadata }
    exclude.map(excludedKey => delete metadata[excludedKey])

    // Compare the existing metadata with the new values and conditionally
    // perform update operations
    for (const key in metadata) {
      if (metadata.hasOwnProperty(key) && currentMetadata.hasOwnProperty(key) && metadata[key] !== currentMetadata[key]) {
        if (key === USER_PROP_NAME_CONSTANTS.NAME) {
          updateOps.push(this.contracts.UserFactoryClient.updateName(userId, metadata[USER_PROP_NAME_CONSTANTS.NAME]))
        }
        if (key === USER_PROP_NAME_CONSTANTS.IS_CREATOR) {
          updateOps.push(this.contracts.UserFactoryClient.updateIsCreator(userId, metadata[USER_PROP_NAME_CONSTANTS.IS_CREATOR]))
        }
        if (key === USER_PROP_NAME_CONSTANTS.BIO) {
          updateOps.push(this.contracts.UserFactoryClient.updateBio(userId, metadata[USER_PROP_NAME_CONSTANTS.BIO]))
        }
        if (key === USER_PROP_NAME_CONSTANTS.LOCATION) {
          updateOps.push(this.contracts.UserFactoryClient.updateLocation(userId, metadata[USER_PROP_NAME_CONSTANTS.LOCATION]))
        }
        if (key === USER_PROP_NAME_CONSTANTS.PROFILE_PICTURE_SIZES) {
          updateOps.push(this.contracts.UserFactoryClient.updateProfilePhoto(
            userId,
            Utils.decodeMultihash(metadata[USER_PROP_NAME_CONSTANTS.PROFILE_PICTURE_SIZES]).digest
          ))
        }
        if (key === USER_PROP_NAME_CONSTANTS.COVER_PHOTO_SIZES) {
          updateOps.push(this.contracts.UserFactoryClient.updateCoverPhoto(
            userId,
            Utils.decodeMultihash(metadata[USER_PROP_NAME_CONSTANTS.COVER_PHOTO_SIZES]).digest
          ))
        }
        if (key === USER_PROP_NAME_CONSTANTS.CREATOR_NODE_ENDPOINT) {
          updateOps.push(this.contracts.UserFactoryClient.updateCreatorNodeEndpoint(userId, metadata[USER_PROP_NAME_CONSTANTS.CREATOR_NODE_ENDPOINT]))
        }
      }
    }

    const ops = await Promise.all(updateOps)
    const latestBlockNumber = Math.max(...ops.map(op => op.txReceipt.blockNumber))

    return { ops: ops, latestBlockNumber }
  }

  _validateUserMetadata (metadata) {
    this.OBJECT_HAS_PROPS(metadata, USER_PROPS, USER_REQUIRED_PROPS)
  }

  // Metadata object may have extra fields. Only keep core fields in USER_PROPS and 'user_id'.
  _cleanUserMetadata (metadata) {
    return pick(metadata, USER_PROPS.concat('user_id'))
  }
}

module.exports = Users
