import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'

import { AlreadyExists, type Item, type Store } from './store.js'

export class DynamoStore implements Store {
  private readonly doc: DynamoDBDocumentClient
  private readonly table: string

  constructor(table: string, region: string) {
    this.doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
      marshallOptions: { removeUndefinedValues: true },
    })
    this.table = table
  }

  async get(pk: string, sk: string): Promise<Item | null> {
    const out = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk, sk } }))
    return (out.Item as Item | undefined) ?? null
  }

  async put(item: Item, opts: { mustNotExist?: boolean } = {}): Promise<void> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: item,
          ...(opts.mustNotExist
            ? { ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)' }
            : {}),
        }),
      )
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        throw new AlreadyExists()
      }
      throw err
    }
  }

  async delete(pk: string, sk: string): Promise<void> {
    await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { pk, sk } }))
  }

  /** Pages until the partition is exhausted. At 25 provisioned read units a
   *  large vault will throttle rather than bill, which is the intended
   *  behaviour — see vault/decisions/0002. */
  async query(pk: string, skPrefix?: string): Promise<Item[]> {
    const items: Item[] = []
    let startKey: Record<string, unknown> | undefined

    do {
      const out = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: skPrefix
            ? 'pk = :pk AND begins_with(sk, :sk)'
            : 'pk = :pk',
          ExpressionAttributeValues: skPrefix ? { ':pk': pk, ':sk': skPrefix } : { ':pk': pk },
          ExclusiveStartKey: startKey,
        }),
      )
      items.push(...((out.Items ?? []) as Item[]))
      startKey = out.LastEvaluatedKey
    } while (startKey)

    return items
  }

  async increment(pk: string, sk: string, expiresAt: number): Promise<number> {
    const out = await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk, sk },
        UpdateExpression: 'ADD #n :one SET expiresAt = if_not_exists(expiresAt, :exp)',
        ExpressionAttributeNames: { '#n': 'count' },
        ExpressionAttributeValues: { ':one': 1, ':exp': expiresAt },
        ReturnValues: 'UPDATED_NEW',
      }),
    )
    return Number((out.Attributes as { count?: number } | undefined)?.count ?? 1)
  }
}
