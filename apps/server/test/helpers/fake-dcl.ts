import { DirectoryUnavailableError, type ActiveScene, type DclDirectory, type ParcelRights } from '../../src/analytics/dcl-directory.js'

export class FakeDclDirectory implements DclDirectory {
  scenes = new Map<string, ActiveScene>() // every parcel → its active scene
  deployers = new Map<string, string>()
  worlds = new Map<string, { sceneUrns: string[]; title?: string }>()
  rights = new Map<string, ParcelRights>()
  estates = new Map<string, string>() // parcel → estate id
  worldOwners = new Map<string, string>()
  worldDeployers = new Map<string, string[]>()
  catalystHosts: string[] = []
  ownedNames = new Map<string, string[]>()
  down = false
  catalystsDown = false
  /** Only the land subgraph (estates) is down. */
  estatesDown = false
  /** Every rights read, and whether it asked for a fresh one. */
  rightsReads: Array<{ parcel: string; fresh: boolean }> = []
  /** Runs before each rights read is answered (a test can change things meanwhile, or wait). */
  onRightsRead: ((parcel: string) => Promise<void> | void) | null = null
  calls = 0

  private hit() {
    this.calls++
    if (this.down) throw new DirectoryUnavailableError('fake directory down')
  }

  /** Register a scene across its parcels. */
  addScene(scene: ActiveScene, deployer?: string) {
    for (const p of scene.parcels) {
      this.scenes.set(p, scene)
      if (deployer) this.deployers.set(p, deployer.toLowerCase())
    }
  }

  async getActiveSceneAt(parcel: string) { this.hit(); return this.scenes.get(parcel) ?? null }
  async getActiveDeployer(parcel: string) { this.hit(); return this.deployers.get(parcel) ?? null }
  async getWorldScene(name: string) { this.hit(); return this.worlds.get(name.toLowerCase()) ?? null }
  async getParcelRights(parcel: string, opts?: { fresh?: boolean }) {
    this.hit()
    this.rightsReads.push({ parcel, fresh: !!opts?.fresh })
    await this.onRightsRead?.(parcel)
    return this.rights.get(parcel) ?? null
  }
  async getParcelEstates(parcels: string[]) {
    this.hit()
    if (this.estatesDown) throw new DirectoryUnavailableError('fake land subgraph down')
    return new Map(parcels.map((p) => [p, this.estates.get(p) ?? null]))
  }
  async getWorldOwner(name: string) { this.hit(); return this.worldOwners.get(name.toLowerCase()) ?? null }
  async getWorldDeployers(name: string) { this.hit(); return this.worldDeployers.get(name.toLowerCase()) ?? [] }
  async getOwnedNames(address: string) { this.hit(); return this.ownedNames.get(address.toLowerCase()) ?? [] }
  async getCatalystHosts() {
    this.calls++
    if (this.catalystsDown) throw new DirectoryUnavailableError('fake catalyst list down')
    return this.catalystHosts.map((h) => h.toLowerCase())
  }
}
