const express = require('express')
const path = require('path')
const fs = require('fs')
const os = require('os')
const errorhandler = require('errorhandler')
const { extractKey, extractKeysForItems, parseKey, doSearch } = require('./util')
const asyncMiddleware = require('./utils/asyncMiddleware')
const bodyParser = require('body-parser')
const pickBy = require('lodash/pickBy')
const omit = require('lodash/omit')
const querystring = require('querystring')
const clc = require('cli-color')
require('es7-object-polyfill')
const AWS = require('aws-sdk')


function createAwsConfig() {
  const env = process.env
  const awsConfig = {
    endpoint:        env.DYNAMO_ENDPOINT || 'http://localhost:8000',
    sslEnabled:      env.DYNAMO_ENDPOINT.indexOf('https://') === 0,
    region:          env.AWS_REGION || 'default region',
    accessKeyId:     env.AWS_ACCESS_KEY_ID || 'default secret key id',
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY || 'default secret access key'
  }

  for (var key in awsConfig) {
    console.log(clc.blackBright(` ${key}: \t${awsConfig[key]}`))    
  }

  return awsConfig
}

exports.createServer = (dynamodb, docClient) => {
  const app = express()
  app.set('json spaces', 2)
  app.set('view engine', 'ejs')
  app.set('views', path.resolve(__dirname, '..', 'views'))

  dynamodb = dynamodb || new AWS.DynamoDB(createAwsConfig())
  docClient = docClient || new AWS.DynamoDB.DocumentClient({service: dynamodb})

  const listTables = (...args) => dynamodb.listTables(...args).promise()
  const describeTable = (...args) => dynamodb.describeTable(...args).promise()
  const getItem = (...args) => docClient.get(...args).promise()

  app.use(errorhandler())
  app.use('/assets', express.static(path.join(__dirname, '..', 'public')))

  app.get('/', asyncMiddleware((req, res) => {
    const listAllTables = (lastEvaluatedTableName, tableNames) => {
      return listTables({ ExclusiveStartTableName: lastEvaluatedTableName })
        .then(data => {
          tableNames = tableNames.concat(data.TableNames)
          if (typeof data.LastEvaluatedTableName !== 'undefined') {
            return listAllTables(data.LastEvaluatedTableName, tableNames)
          }
          return Promise.all(
            tableNames.map(TableName => {
              return describeTable({ TableName }).then(data => data.Table)
            })
          )
        })
    }

    return listAllTables(null, [])
      .then(data => {
        res.render('tables', { data })
      })
  }))

  app.get('/create-table', (req, res) => {
    res.render('create-table', {})
  })

  app.get('/tables/:TableName/get', asyncMiddleware((req, res) => {
    const TableName = req.params.TableName
    if (req.query.hash) {
      if (req.query.range) {
        return res.redirect(
          `/tables/${encodeURIComponent(TableName)}/items/${
            encodeURIComponent(req.query.hash)},${encodeURIComponent(req.query.range)}`
        )
      } else {
        return res.redirect(`/tables/${
          encodeURIComponent(TableName)}/items/${encodeURIComponent(req.query.hash)}`)
      }
    }

    return describeTable({ TableName })
      .then(description => {
        const hashKey = description.Table.KeySchema.find(schema => {
          return schema.KeyType === 'HASH'
        })
        if (hashKey) {
          hashKey.AttributeType = description.Table.AttributeDefinitions.find(
            definition => {
              return definition.AttributeName === hashKey.AttributeName
            }
          ).AttributeType
        }
        const rangeKey = description.Table.KeySchema.find(schema => {
          return schema.KeyType === 'RANGE'
        })
        if (rangeKey) {
          rangeKey.AttributeType = description.Table.AttributeDefinitions.find(
            definition => {
              return definition.AttributeName === rangeKey.AttributeName
            }
          ).AttributeType
        }
        res.render(
          'get',
          Object.assign({}, description, {
            hashKey,
            rangeKey
          })
        )
      })
  }))

  const getPage = (docClient, keySchema, TableName, scanParams, pageSize,
                   startKey) => {
    const pageItems = []

    function onNewItems(items, lastStartKey) {
      for (let i = 0; i < items.length && pageItems.length < pageSize + 1; i++) {
        pageItems.push(items[i])
      }

      // If there is more items to query (!lastStartKey) then don't stop until
      // we are over pageSize count. Stopping at exactly pageSize count would
      // not extract key of last item later and make pagination not work.
      return pageItems.length > pageSize || !lastStartKey
    }

    return doSearch(docClient, TableName, scanParams, 10, startKey, onNewItems)
      .then(items => {
        let nextKey = null

        if (items.length > pageSize) {
          items = items.slice(0, pageSize)
          nextKey = extractKey(items[pageSize - 1], keySchema)
        }

        return {
          pageItems: items,
          nextKey,
        }
      })
  }

  app.get('/tables/:TableName', asyncMiddleware((req, res) => {
    const TableName = req.params.TableName
    req.query = pickBy(req.query)
    const filters = omit(req.query, ['_hash', 'range', 'prevKey', 'startKey', 'pageNum'])

    return describeTable({ TableName })
      .then(description => {
        const pageNum = req.query.pageNum ? parseInt(req.query.pageNum) : 1
        const ExpressionAttributeNames = {}
        const ExpressionAttributeValues = {}
        const FilterExpressions = []

        for (const key in filters) {
          const attributeDefinition = description.Table.AttributeDefinitions.find(
            definition => {
              return definition.AttributeName === key
            }
          )
          if (attributeDefinition && attributeDefinition.AttributeType === 'N') {
            req.query[key] = Number(req.query[key])
          }
          ExpressionAttributeNames[`#${key}`] = key
          ExpressionAttributeValues[`:${key}`] = req.query[key]

          FilterExpressions.push(`#${key} = :${key}`)
        }

        const data = Object.assign({}, description, {
          query: req.query,
          omit,
          filters,
          pageNum: pageNum,
          filterQueryString: querystring.stringify(filters),
        })
        res.render('scan', data)
      })
  }))

  app.get('/tables/:TableName/items', asyncMiddleware((req, res) => {
    const TableName = req.params.TableName
    req.query = pickBy(req.query)
    const filters = omit(req.query, ['_hash', 'range', 'prevKey', 'startKey', 'pageNum'])

    return describeTable({ TableName })
      .then(description => {
        const ExclusiveStartKey = req.query.startKey
          ? JSON.parse(req.query.startKey)
          : {}
        const pageNum = req.query.pageNum ? parseInt(req.query.pageNum) : 1
        const ExpressionAttributeNames = {}
        const ExpressionAttributeValues = {}
        const FilterExpressions = []

        for (const key in filters) {
          const attributeDefinition = description.Table.AttributeDefinitions.find(
            definition => {
              return definition.AttributeName === key
            }
          )
          if (attributeDefinition && attributeDefinition.AttributeType === 'N') {
            req.query[key] = Number(req.query[key])
          }
          ExpressionAttributeNames[`#${key}`] = key
          ExpressionAttributeValues[`:${key}`] = req.query[key]

          FilterExpressions.push(`#${key} = :${key}`)
        }

        const params = pickBy({
          TableName,
          FilterExpression: FilterExpressions.length
            ? FilterExpressions.join(' AND ')
            : undefined,
          ExpressionAttributeNames: Object.keys(ExpressionAttributeNames).length
            ? ExpressionAttributeNames
            : undefined,
          ExpressionAttributeValues: Object.keys(ExpressionAttributeValues).length
            ? ExpressionAttributeValues
            : undefined
        })

        const startKey = Object.keys(ExclusiveStartKey).length
          ? ExclusiveStartKey
          : undefined

        return getPage(docClient, description.Table.KeySchema, TableName,
                       params, 25, startKey)
          .then(results => {
            const {pageItems, nextKey} = results

            const nextKeyParam = nextKey
              ? encodeURIComponent(JSON.stringify(nextKey))
              : null

            const primaryKeys = description.Table.KeySchema.map(
              schema => schema.AttributeName)
            // Primary keys are listed first.
            const uniqueKeys = [
              ...primaryKeys,
              ...extractKeysForItems(pageItems).filter(key => !primaryKeys.includes(key)),
            ]

            // Append the item key.
            for (const item of pageItems) {
              item.__key = extractKey(item, description.Table.KeySchema)
            }

            const data = Object.assign({}, description, {
              query: req.query,
              omit,
              filters,
              pageNum: pageNum,
              prevKey: encodeURIComponent(req.query.prevKey || ''),
              startKey: encodeURIComponent(req.query.startKey || ''),
              nextKey: nextKeyParam,
              filterQueryString: querystring.stringify(filters),
              Items: pageItems,
              primaryKeys,
              uniqueKeys,
            })

            res.json(data)
          })
      })
  }))

  app.get('/tables/:TableName/meta', asyncMiddleware((req, res) => {
    const TableName = req.params.TableName
    return Promise.all([
      describeTable({ TableName }),
      docClient.scan({ TableName }).promise()
    ])
      .then(([description, items]) => {
        const data = Object.assign({}, description, items)
        res.render('meta', data)
      })
  }))

  app.get('/tables/:TableName/add-item', asyncMiddleware((req, res) => {
    const TableName = req.params.TableName
    return describeTable({ TableName })
      .then(result => {
        const table = result.Table
        const Item = {}
        table.KeySchema.forEach(key => {
          const definition = table.AttributeDefinitions.find(attribute => {
            return attribute.AttributeName === key.AttributeName
          })
          Item[key.AttributeName] = definition.AttributeType === 'S' ? '' : 0
        })
        res.render('item', {
          Table: table,
          TableName: req.params.TableName,
          Item: Item,
          isNew: true
        })
      })
  }))

  app.get('/tables/:TableName/items/:key', asyncMiddleware((req, res) => {
    const TableName = req.params.TableName
    return describeTable({ TableName })
      .then(result => {
        const params = {
          TableName,
          Key: parseKey(req.params.key, result.Table)
        }

        return getItem(params).then(response => {
          if (!response.Item) {
            return res.status(404).send('Not found')
          }
          res.render('item', {
            Table: result.Table,
            TableName: req.params.TableName,
            Item: response.Item,
            isNew: false
          })
        })
      })
  }))

  app.use((err, req, res, next) => {
    console.error(err)
    next(err)
  })

  return app
}
