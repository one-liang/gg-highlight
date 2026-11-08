// Generates the media fixtures (tests/.tmp/fixtures) the specs pick and upload.
import { fixtures } from '../fixtures'

export default function globalSetup() {
  fixtures()
}
