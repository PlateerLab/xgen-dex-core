/**
 * 모바일 첨부·앱 화면의 순수 규칙 — 2026-10-02.
 *
 * 첨부는 이제 파일을 경로로 흘려보낸다(RN 의 Blob 은 바이트로 만들 수 없어 모든 첨부가 실패했다).
 * 그래서 내용은 앞 16바이트만 읽어 그림인지 보고, 이름을 작업 공간에 맞게 고친다.
 * 앱 화면은 서버가 준 경로만 서버 주소에 붙여 연다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { attachmentName, base64Bytes, imageMime } from '../src/lib/attachment-file'
import { serverLink } from '../src/lib/links'

test('앞 16바이트(base64)로 그림 종류를 안다', () => {
  assert.equal(imageMime(base64Bytes('/9j/4AAQSkZJRgABAQ==')), 'image/jpeg')
  assert.equal(imageMime(base64Bytes('iVBORw0KGgoAAAANSUhEUg==')), 'image/png')
  assert.equal(imageMime(base64Bytes('UklGRiQAAABXRUJQVlA4')), 'image/webp')
  assert.equal(imageMime(base64Bytes('JVBERi0xLjcKJcfsj6I=')), undefined, 'PDF 는 그림이 아니다')
  assert.equal(imageMime(base64Bytes('')), undefined)
})

test('이름: 한글은 NFC, 그림은 내용에 맞는 확장자', () => {
  const nfd = '사진'.normalize('NFD') + '.jpg'
  assert.equal(attachmentName(nfd, 'image/jpeg'), '사진.jpg')
  assert.equal(attachmentName('IMG_0001.HEIC', 'image/jpeg'), 'IMG_0001.jpg', 'JPEG 로 받은 HEIC 사진')
  assert.equal(attachmentName('photo.jpeg', 'image/jpeg'), 'photo.jpeg')
  assert.equal(attachmentName('scan', 'image/png'), 'scan.png')
  assert.equal(attachmentName('보고서.pdf', undefined), '보고서.pdf')
  assert.equal(attachmentName('', undefined), 'file')
})

test('앱 주소는 서버가 준 경로만 서버 주소에 붙인다', () => {
  const base = 'https://xgen.example.com'
  assert.equal(serverLink(base, '/app/wf/map'), 'https://xgen.example.com/app/wf/map')
  assert.equal(serverLink(`${base}/`, '/share/app/wf/map/tok'), 'https://xgen.example.com/share/app/wf/map/tok')
  for (const bad of ['https://evil.example/x', '//evil.example/x', 'app/wf/map', '']) {
    assert.equal(serverLink(base, bad), '', bad)
  }
})
