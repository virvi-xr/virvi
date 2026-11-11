import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface StorageProvider {
  upload(key: string, data: Buffer, contentType: string): Promise<string>
  delete(key: string): Promise<void>
  getPublicUrl(key: string): string
}

export type StorageProviderName = 'local' | 's3' | 'r2'
const STORAGE_PROVIDERS: readonly StorageProviderName[] = ['local', 's3', 'r2']

/**
 * Which storage uploads go to: STORAGE_PROVIDER, else s3 in cloud mode and local disk otherwise. An unknown value
 * (such as the old `supabase`) is an error rather than a silent fall back to local disk, which loses every upload
 * when a container is replaced.
 */
export function resolveStorageProvider(env: NodeJS.ProcessEnv = process.env): StorageProviderName {
  const value = env.STORAGE_PROVIDER?.trim()
  if (!value) return env.VIRVI_MODE === 'cloud' ? 's3' : 'local'
  if ((STORAGE_PROVIDERS as readonly string[]).includes(value)) return value as StorageProviderName
  throw new Error(`STORAGE_PROVIDER=${value} isn't supported. Use local, s3 or r2.`)
}

export function createStorage(): StorageProvider {
  return resolveStorageProvider() === 'local' ? new LocalStorage() : new S3Storage()
}

class LocalStorage implements StorageProvider {
  private basePath: string
  private baseUrl: string

  constructor() {
    this.basePath = process.env.LOCAL_STORAGE_PATH || './uploads'
    this.baseUrl = (process.env.PUBLIC_URL || 'http://localhost:3010') + '/uploads'
    if (!existsSync(this.basePath)) {
      mkdirSync(this.basePath, { recursive: true })
    }
  }

  async upload(key: string, data: Buffer, contentType: string): Promise<string> {
    const dir = dirname(join(this.basePath, key))
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(join(this.basePath, key), data)
    return this.getPublicUrl(key)
  }

  async delete(key: string): Promise<void> {
    const filePath = join(this.basePath, key)
    if (existsSync(filePath)) {
      unlinkSync(filePath)
    }
  }

  getPublicUrl(key: string): string {
    return `${this.baseUrl}/${key}`
  }
}

class S3Storage implements StorageProvider {
  private bucket: string
  private publicBase: string
  private client: import('@aws-sdk/client-s3').S3Client | null = null

  constructor() {
    this.bucket = process.env.S3_BUCKET || ''
    if (!this.bucket) throw new Error('S3_BUCKET is required when using s3/r2 storage')

    // CDN_URL takes priority, then construct from endpoint + bucket
    const endpoint = process.env.S3_ENDPOINT || ''
    this.publicBase = process.env.CDN_URL
      || (endpoint ? `${endpoint.replace(/\/$/, '')}/${this.bucket}` : `https://${this.bucket}.s3.amazonaws.com`)
  }

  private async getClient() {
    if (this.client) return this.client
    const { S3Client } = await import('@aws-sdk/client-s3')
    this.client = new S3Client({
      region: process.env.S3_REGION || 'auto',
      ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true } : {}),
    })
    return this.client
  }

  async upload(key: string, data: Buffer, contentType: string): Promise<string> {
    const client = await this.getClient()
    const { PutObjectCommand } = await import('@aws-sdk/client-s3')
    await client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: data,
      ContentType: contentType,
    }))
    return this.getPublicUrl(key)
  }

  async delete(key: string): Promise<void> {
    const client = await this.getClient()
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3')
    await client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }))
  }

  getPublicUrl(key: string): string {
    return `${this.publicBase}/${key}`
  }
}
