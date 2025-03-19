/* module.exports = {
  logType: 3,

  rtmp: {
    port: 1935,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60
  },

  http: {
    port: 80,
    allow_origin: '*',
    api: true
  },

  trans: {
    ffmpeg: '/usr/bin/ffmpeg',
    tasks: [
      {
        app: 'live',
        mediaRoot: '/var/www/hls', // 👈 move it here, inside the task!
        hls: true,
        hlsFlags: '[hls_time=3:hls_list_size=5:hls_flags=delete_segments]',
        hlsKeep: true,
        hlsPath: '/var/www/hls'
      }
    ]
  }
}
 */