'use strict'

/**
 * Content Tables = AudiusUsers, Tracks, Files
 * CNodeUsers Table considered a Reference Table only
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction()

    // TODO remove - Add 'clock2' column to all 4 data tables
    await addClock2Column(queryInterface, Sequelize, transaction, true)

    // Add 'clock' column to all 4 tables
    await addClockColumn(queryInterface, Sequelize, transaction, false)

    // Add composite uniqueness constraint on (cnodeUserUUID, clock) to all Content Tables
    await addUniquenessConstraints(queryInterface, Sequelize, transaction)

    // Create Clock table
    await createClockRecordsTable(queryInterface, Sequelize, transaction)

    await transaction.commit()
  },

  // TODO
  down: async (queryInterface, Sequelize) => {
    // Remove uniqueness constraints on (cnodeUserUUID, clock) on all 4 tables
    await queryInterface.removeConstraint(
      'CNodeUsers',
      'CNodeUsers_unique_constraint_(cnodeUserUUID,clock)'
    )
    await queryInterface.removeConstraint(
      'AudiusUsers',
      'AudiusUsers_unique_constraint_(cnodeUserUUID,clock)'
    )
    await queryInterface.removeConstraint(
      'Tracks',
      'Tracks_unique_constraint_(cnodeUserUUID,clock)'
    )

    // Remove clock columns on all 4 tables
    await queryInterface.removeColumn('CNodeUsers', 'clock')
    await queryInterface.removeColumn('AudiusUsers', 'clock')
    await queryInterface.removeColumn('Tracks', 'clock')
    await queryInterface.removeColumn('Files', 'clock')
  }
}

async function addClockColumn (queryInterface, Sequelize, transaction, allowNull) {
  await queryInterface.addColumn('CNodeUsers', 'clock', {
    type: Sequelize.INTEGER,
    unique: false,
    allowNull
  }, { transaction })
  await queryInterface.addColumn('AudiusUsers', 'clock', {
    type: Sequelize.INTEGER,
    unique: false,
    allowNull
  }, { transaction })
  await queryInterface.addColumn('Tracks', 'clock', {
    type: Sequelize.INTEGER,
    unique: false,
    allowNull
  }, { transaction })
  await queryInterface.addColumn('Files', 'clock', {
    type: Sequelize.INTEGER,
    unique: false,
    allowNull
  }, { transaction })
}

async function addClock2Column (queryInterface, Sequelize, transaction, allowNull) {
  await queryInterface.addColumn('CNodeUsers', 'clock2', {
    type: Sequelize.INTEGER,
    unique: false,
    allowNull
  }, { transaction })
  await queryInterface.addColumn('AudiusUsers', 'clock2', {
    type: Sequelize.INTEGER,
    unique: false,
    allowNull
  }, { transaction })
  await queryInterface.addColumn('Tracks', 'clock2', {
    type: Sequelize.INTEGER,
    unique: false,
    allowNull
  }, { transaction })
  await queryInterface.addColumn('Files', 'clock2', {
    type: Sequelize.INTEGER,
    unique: false,
    allowNull
  }, { transaction })
}

// Add uniqueness constraint on composite (cnodeUserUUId, clock) to Content Tables
async function addUniquenessConstraints (queryInterface, Sequelize, transaction) {
  await queryInterface.addConstraint(
    'AudiusUsers',
    {
      type: 'UNIQUE',
      fields: ['cnodeUserUUID', 'clock'],
      name: 'AudiusUsers_unique_constraint_(cnodeUserUUID,clock)',
      transaction
    }
  )
  await queryInterface.addConstraint(
    'Tracks',
    {
      type: 'UNIQUE',
      fields: ['cnodeUserUUID', 'clock'],
      name: 'Tracks_unique_constraint_(cnodeUserUUID,clock)',
      transaction
    }
  )
  await queryInterface.addConstraint(
    'Files',
    {
      type: 'UNIQUE',
      fields: ['cnodeUserUUID', 'clock'],
      name: 'Files_unique_constraint_(cnodeUserUUID,clock)',
      transaction
    }
  )
}

async function createClockRecordsTable (queryInterface, Sequelize, transaction) {
  await queryInterface.createTable('ClockRecords', {
    cnodeUserUUID: {
      type: Sequelize.UUID,
      primaryKey: true, // composite PK with clock
      unique: false,
      allowNull: false,
      references: {
        model: 'CNodeUsers',
        key: 'cnodeUserUUID',
        as: 'cnodeUserUUID'
      },
      onDelete: 'RESTRICT'
    },
    clock: {
      type: Sequelize.INTEGER,
      primaryKey: true, // composite PK with cnodeUserUUID
      unique: false,
      allowNull: false
    },
    sourceTable: {
      // TODO - if this doesn't work, use models/file.js:L46
      type: Sequelize.ENUM('AudiusUser', 'Track', 'File'),
      allowNull: false
    },
    createdAt: {
      allowNull: false,
      type: Sequelize.DATE
    },
    updatedAt: {
      allowNull: false,
      type: Sequelize.DATE
    }
  }, { transaction })
}