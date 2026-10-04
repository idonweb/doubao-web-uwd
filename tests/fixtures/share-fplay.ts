/**
 * 分享页无水印 —— **真实响应样本**（2026-10-03 第二十七轮 §47.11 实测抓取）
 *
 * 来源：`/thread/xgMYzKFHEyaAvln4Q` 分享页里匿名拿到的 `fallback_api`，
 * 换成 `codec_type=1`（轻量档）后的 fplay 响应。
 *
 * ⚠️ 这些是**静态样本**（签名早已过期，**不要拿它去下载**）；用途只有一个：
 * 让 `decodeQaabToken` 的 KDF / 切片 / 填充规则**在单测里被真实数据钉住**。
 * 以前的那种「自己加密再自己解密」的自证式测试抓不到 KDF 写错，这个可以。
 */
export const SHARE_FPLAY_FALLBACK_API =
  'https://vas-lf-x.snssdk.com/video/fplay/1/2abd5bc44c4d3bb65e892b19f934b6db/v0369cg10004davr5qi7dld24a4htghg?aid=482431&codec_type=5&device_platform=unknown&force_fids=YTNkZTs3NDEx&imp=false&key_seed=2BDh1Nkl3rdHfRGh8zGt%2Fc%2F6CWZNto3sYZ7qjAR5NEw%3D&logo_type=video_gen_watermark_dyn&multi_rate_audios=true&stream_type=normal&vps=6';

export const SHARE_FPLAY_KEY_SEED = '2BDh1Nkl3rdHfRGh8zGt/c/6CWZNto3sYZ7qjAR5NEw=';

/** `video_list[0].main_url` —— qAAB token（前 4 字节 = a8 00 01 00） */
export const SHARE_FPLAY_TOKEN = 'qAABAHYGJ5+2oKLm0LSi0Mo3MpEoDfItzGmbzsrj3oeDZc2hqeqD85gp3KjdJPzeeaqTOKet/YxRa8PDQVg4N3DwOhyBJnk7NLq2dxzYg0ncBWEp6Im3Li3bvD8b0mRUdrBdNmLI34yHrKw4Q3Zy1XBQA5tAaEq2zwM9FWah5aMFHnnhZNOUglc3ln9F1rDlhuSsYKPRceRyPcWzedBLGBkrlrdRfAIP7Lf/sn5bti7LgHBuGysCn6BVeMQy9mmgIDDwDI7Twncw/fGLTSfHDCJFMKraJXzlNouHFxGBH0DBxwt2LYPFDo/0yff2KgxDlB0fxZSIBBCYzc9GJfZvQ/tPw0BHJBI0PMoQLXxccKXFW0tHRGmKAs1xXy+AneqEY9Zadtielnrc5wWfAHe2VQhiraK2gul9tmNSjjCb2BXxoOZ7B4q+xX9w/viXfkO5GffUBG1ylv43pbZiAH9sVxPGn3Ll1xHSMnGuR45vsPz26ksppCs/bYtewPWFHJMB0ljc4dpmPyvMpwqhdGxubVE3+1p7qwGST5ijogkQmD130HhzmUo0+ikABrm2lmb77jFzl3nUpoqtgUuVmHRNXoIdBqhwc/icOJ2NONjxzI4XVbkcjGQqCPB+cP4eJ1Ezsv5D8NjykH3b4RFxCGnv8mruYIA/SoBEuL06yP/10V891N+uB1ZWTRN96ZCH6+8zi7I+0Q==';

/** 上面这个 token 在测试里应当被解出的明文直链（含当时的时效签名，逐字符比对） */
export const SHARE_FPLAY_EXPECTED_URL = 'https://v26-vdl.doubao.com/0dd57fcebe79b326dc89b9ba2f1fad39/6ac0e914/video/tos/cn/tos-cn-v-9ecd54/oU7vDgqR1ReL7BZCg2RgRvA87aiiGqApjIMxFf/?a=482431&ch=0&cr=1&dr=0&er=0&net=5&cd=0%7C0%7C0%7C1&cv=1&br=1412&bt=1412&cs=1&ds=3&ft=WTaUy4h8FuuD.WNOan2-vjp~fytLjrKVhSXuRka5_LGaejVhWL6&mime_type=video_mp4&qs=0&rc=ODNlZmdmMzVpZzc8PDRoaUBpamprZDVvOnR1ZDczNGY5M0AyNC5eLzMwNS4xYC1iYjVeYSNlcTExYWFmMnNhLS1kNjBzcw%3D%3D&btag=80000e00008000&dy_q=1791023866&feature_id=9b7f6bfb73c3b0be182dc2261c6c1cd7&l=202610031837466A8E01277F4252873539';
