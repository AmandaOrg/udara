export class AppConfigView {
  /**
   * The oldest app version (x.y.z) the server still supports. An older app
   * shows an update screen. Null when there is no minimum.
   */
  minSupportedVersion!: string | null;
}
