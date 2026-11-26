;; Argon2id memory filling (RFC 9106, version 0x13), the part of Argon2 that
;; costs time and memory. The rest (H0, H', the final hash) is BLAKE2b in
;; src/argon2.ts, which writes the first two blocks of each lane before calling
;; `fill` and reads the last block of each lane afterwards.
;;
;; This file is the source. scripts/build-argon2.mjs assembles it with a pinned
;; wabt into src/argon2-wasm.ts (base64 and SHA-256), and CI checks that the
;; committed bytes are exactly what this source produces.
;;
;; Memory layout (bytes):
;;   0     R        the XOR of the two input blocks
;;   1024  Z        R, permuted in place
;;   2048  ADDR     the address block (data-independent passes)
;;   3072  INPUT    the input block that generates addresses
;;   4096  ZERO     a block of zeros
;;   8192  memory   lanes × laneLength blocks of 1024 bytes, lane by lane
;; The caller grows memory to 8192 + 1024 × lanes × laneLength bytes.

(module
  (memory (export "memory") 1)

  (global $R i32 (i32.const 0))
  (global $Z i32 (i32.const 1024))
  (global $ADDR i32 (i32.const 2048))
  (global $INPUT i32 (i32.const 3072))
  (global $ZERO i32 (i32.const 4096))
  (global $BASE i32 (i32.const 8192))

  ;; BlaMka: x + y + 2 * lo32(x) * lo32(y), all mod 2^64.
  (func $f (param $x i64) (param $y i64) (result i64)
    (i64.add
      (i64.add (local.get $x) (local.get $y))
      (i64.shl
        (i64.mul
          (i64.and (local.get $x) (i64.const 0xffffffff))
          (i64.and (local.get $y) (i64.const 0xffffffff)))
        (i64.const 1))))

  ;; The G function on four words held in memory at the given addresses.
  (func $G (param $a i32) (param $b i32) (param $c i32) (param $d i32)
    (local $va i64) (local $vb i64) (local $vc i64) (local $vd i64)
    (local.set $va (i64.load (local.get $a)))
    (local.set $vb (i64.load (local.get $b)))
    (local.set $vc (i64.load (local.get $c)))
    (local.set $vd (i64.load (local.get $d)))
    (local.set $va (call $f (local.get $va) (local.get $vb)))
    (local.set $vd (i64.rotr (i64.xor (local.get $vd) (local.get $va)) (i64.const 32)))
    (local.set $vc (call $f (local.get $vc) (local.get $vd)))
    (local.set $vb (i64.rotr (i64.xor (local.get $vb) (local.get $vc)) (i64.const 24)))
    (local.set $va (call $f (local.get $va) (local.get $vb)))
    (local.set $vd (i64.rotr (i64.xor (local.get $vd) (local.get $va)) (i64.const 16)))
    (local.set $vc (call $f (local.get $vc) (local.get $vd)))
    (local.set $vb (i64.rotr (i64.xor (local.get $vb) (local.get $vc)) (i64.const 63)))
    (i64.store (local.get $a) (local.get $va))
    (i64.store (local.get $b) (local.get $vb))
    (i64.store (local.get $c) (local.get $vc))
    (i64.store (local.get $d) (local.get $vd)))

  ;; One BLAKE2b round without message words, over sixteen words.
  (func $P
    (param $v0 i32) (param $v1 i32) (param $v2 i32) (param $v3 i32)
    (param $v4 i32) (param $v5 i32) (param $v6 i32) (param $v7 i32)
    (param $v8 i32) (param $v9 i32) (param $v10 i32) (param $v11 i32)
    (param $v12 i32) (param $v13 i32) (param $v14 i32) (param $v15 i32)
    (call $G (local.get $v0) (local.get $v4) (local.get $v8) (local.get $v12))
    (call $G (local.get $v1) (local.get $v5) (local.get $v9) (local.get $v13))
    (call $G (local.get $v2) (local.get $v6) (local.get $v10) (local.get $v14))
    (call $G (local.get $v3) (local.get $v7) (local.get $v11) (local.get $v15))
    (call $G (local.get $v0) (local.get $v5) (local.get $v10) (local.get $v15))
    (call $G (local.get $v1) (local.get $v6) (local.get $v11) (local.get $v12))
    (call $G (local.get $v2) (local.get $v7) (local.get $v8) (local.get $v13))
    (call $G (local.get $v3) (local.get $v4) (local.get $v9) (local.get $v14)))

  ;; out = P(x ^ y) ^ (x ^ y), XORed into the old out when $xor is set.
  ;; Reads x and y fully before writing out, so out may be x or y.
  (func $compress (param $x i32) (param $y i32) (param $out i32) (param $xor i32)
    (local $k i32) (local $v i64) (local $i i32) (local $z i32)
    ;; R = Z = x ^ y
    (local.set $k (i32.const 0))
    (loop $copy
      (local.set $v (i64.xor
        (i64.load (i32.add (local.get $x) (local.get $k)))
        (i64.load (i32.add (local.get $y) (local.get $k)))))
      (i64.store (i32.add (global.get $R) (local.get $k)) (local.get $v))
      (i64.store (i32.add (global.get $Z) (local.get $k)) (local.get $v))
      (local.set $k (i32.add (local.get $k) (i32.const 8)))
      (br_if $copy (i32.lt_u (local.get $k) (i32.const 1024))))
    ;; Rows: words 16i .. 16i+15.
    (local.set $i (i32.const 0))
    (loop $rows
      (local.set $z (i32.add (global.get $Z) (i32.mul (local.get $i) (i32.const 128))))
      (call $P
        (local.get $z) (i32.add (local.get $z) (i32.const 8)) (i32.add (local.get $z) (i32.const 16)) (i32.add (local.get $z) (i32.const 24))
        (i32.add (local.get $z) (i32.const 32)) (i32.add (local.get $z) (i32.const 40)) (i32.add (local.get $z) (i32.const 48)) (i32.add (local.get $z) (i32.const 56))
        (i32.add (local.get $z) (i32.const 64)) (i32.add (local.get $z) (i32.const 72)) (i32.add (local.get $z) (i32.const 80)) (i32.add (local.get $z) (i32.const 88))
        (i32.add (local.get $z) (i32.const 96)) (i32.add (local.get $z) (i32.const 104)) (i32.add (local.get $z) (i32.const 112)) (i32.add (local.get $z) (i32.const 120)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $rows (i32.lt_u (local.get $i) (i32.const 8))))
    ;; Columns: words 2i, 2i+1, 2i+16, 2i+17, …, 2i+112, 2i+113.
    (local.set $i (i32.const 0))
    (loop $cols
      (local.set $z (i32.add (global.get $Z) (i32.mul (local.get $i) (i32.const 16))))
      (call $P
        (local.get $z) (i32.add (local.get $z) (i32.const 8)) (i32.add (local.get $z) (i32.const 128)) (i32.add (local.get $z) (i32.const 136))
        (i32.add (local.get $z) (i32.const 256)) (i32.add (local.get $z) (i32.const 264)) (i32.add (local.get $z) (i32.const 384)) (i32.add (local.get $z) (i32.const 392))
        (i32.add (local.get $z) (i32.const 512)) (i32.add (local.get $z) (i32.const 520)) (i32.add (local.get $z) (i32.const 640)) (i32.add (local.get $z) (i32.const 648))
        (i32.add (local.get $z) (i32.const 768)) (i32.add (local.get $z) (i32.const 776)) (i32.add (local.get $z) (i32.const 896)) (i32.add (local.get $z) (i32.const 904)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $cols (i32.lt_u (local.get $i) (i32.const 8))))
    ;; out = Z ^ R (^ out)
    (local.set $k (i32.const 0))
    (loop $final
      (local.set $v (i64.xor
        (i64.load (i32.add (global.get $Z) (local.get $k)))
        (i64.load (i32.add (global.get $R) (local.get $k)))))
      (if (local.get $xor)
        (then (local.set $v (i64.xor (local.get $v) (i64.load (i32.add (local.get $out) (local.get $k)))))))
      (i64.store (i32.add (local.get $out) (local.get $k)) (local.get $v))
      (local.set $k (i32.add (local.get $k) (i32.const 8)))
      (br_if $final (i32.lt_u (local.get $k) (i32.const 1024)))))

  (func $clear (param $p i32)
    (local $k i32)
    (local.set $k (i32.const 0))
    (loop $l
      (i64.store (i32.add (local.get $p) (local.get $k)) (i64.const 0))
      (local.set $k (i32.add (local.get $k) (i32.const 8)))
      (br_if $l (i32.lt_u (local.get $k) (i32.const 1024)))))

  (func $nextAddresses
    (i64.store offset=48 (global.get $INPUT) (i64.add (i64.load offset=48 (global.get $INPUT)) (i64.const 1)))
    (call $compress (global.get $ZERO) (global.get $INPUT) (global.get $ADDR) (i32.const 0))
    (call $compress (global.get $ZERO) (global.get $ADDR) (global.get $ADDR) (i32.const 0)))

  ;; The reference block's index within its lane (RFC 9106, 3.4.1.2).
  (func $indexAlpha (param $pass i32) (param $slice i32) (param $index i32) (param $rand i64) (param $same i32)
                    (param $laneLen i32) (param $segLen i32) (result i32)
    (local $area i64) (local $rel i64) (local $start i64)
    (if (i32.eqz (local.get $pass))
      (then
        (if (i32.eqz (local.get $slice))
          (then (local.set $area (i64.extend_i32_u (i32.sub (local.get $index) (i32.const 1)))))
          (else
            (if (local.get $same)
              (then (local.set $area (i64.extend_i32_u (i32.sub
                (i32.add (i32.mul (local.get $slice) (local.get $segLen)) (local.get $index)) (i32.const 1)))))
              (else (local.set $area (i64.extend_i32_u (i32.sub
                (i32.mul (local.get $slice) (local.get $segLen)) (i32.eqz (local.get $index))))))))))
      (else
        (if (local.get $same)
          (then (local.set $area (i64.extend_i32_u (i32.sub
            (i32.add (i32.sub (local.get $laneLen) (local.get $segLen)) (local.get $index)) (i32.const 1)))))
          (else (local.set $area (i64.extend_i32_u (i32.sub
            (i32.sub (local.get $laneLen) (local.get $segLen)) (i32.eqz (local.get $index)))))))))
    (local.set $rel (i64.shr_u (i64.mul (local.get $rand) (local.get $rand)) (i64.const 32)))
    (local.set $rel (i64.sub (i64.sub (local.get $area) (i64.const 1))
      (i64.shr_u (i64.mul (local.get $area) (local.get $rel)) (i64.const 32))))
    (local.set $start (i64.const 0))
    (if (i32.and (i32.ne (local.get $pass) (i32.const 0)) (i32.ne (local.get $slice) (i32.const 3)))
      (then (local.set $start (i64.extend_i32_u (i32.mul (i32.add (local.get $slice) (i32.const 1)) (local.get $segLen))))))
    (i32.wrap_i64 (i64.rem_u (i64.add (local.get $start) (local.get $rel)) (i64.extend_i32_u (local.get $laneLen)))))

  (func $segment (param $pass i32) (param $slice i32) (param $lane i32) (param $lanes i32)
                 (param $laneLen i32) (param $segLen i32) (param $passes i32)
    (local $indep i32) (local $i i32) (local $curr i32) (local $prev i32)
    (local $rand i64) (local $refLane i32) (local $refIndex i32)
    (local.set $indep (i32.and (i32.eqz (local.get $pass)) (i32.lt_u (local.get $slice) (i32.const 2))))
    (if (local.get $indep)
      (then
        (call $clear (global.get $ZERO))
        (call $clear (global.get $INPUT))
        (call $clear (global.get $ADDR))
        (i64.store offset=0 (global.get $INPUT) (i64.extend_i32_u (local.get $pass)))
        (i64.store offset=8 (global.get $INPUT) (i64.extend_i32_u (local.get $lane)))
        (i64.store offset=16 (global.get $INPUT) (i64.extend_i32_u (local.get $slice)))
        (i64.store offset=24 (global.get $INPUT) (i64.extend_i32_u (i32.mul (local.get $lanes) (local.get $laneLen))))
        (i64.store offset=32 (global.get $INPUT) (i64.extend_i32_u (local.get $passes)))
        (i64.store offset=40 (global.get $INPUT) (i64.const 2))))
    (local.set $i (i32.const 0))
    (if (i32.and (i32.eqz (local.get $pass)) (i32.eqz (local.get $slice)))
      (then
        (local.set $i (i32.const 2))
        (if (local.get $indep) (then (call $nextAddresses)))))
    (local.set $curr (i32.add
      (i32.add (i32.mul (local.get $lane) (local.get $laneLen)) (i32.mul (local.get $slice) (local.get $segLen)))
      (local.get $i)))
    (if (i32.eqz (i32.rem_u (local.get $curr) (local.get $laneLen)))
      (then (local.set $prev (i32.sub (i32.add (local.get $curr) (local.get $laneLen)) (i32.const 1))))
      (else (local.set $prev (i32.sub (local.get $curr) (i32.const 1)))))
    (block $done
      (loop $each
        (br_if $done (i32.ge_u (local.get $i) (local.get $segLen)))
        (if (i32.eq (i32.rem_u (local.get $curr) (local.get $laneLen)) (i32.const 1))
          (then (local.set $prev (i32.sub (local.get $curr) (i32.const 1)))))
        (if (local.get $indep)
          (then
            (if (i32.eqz (i32.and (local.get $i) (i32.const 127))) (then (call $nextAddresses)))
            (local.set $rand (i64.load (i32.add (global.get $ADDR) (i32.shl (i32.and (local.get $i) (i32.const 127)) (i32.const 3))))))
          (else
            (local.set $rand (i64.load (i32.add (global.get $BASE) (i32.shl (local.get $prev) (i32.const 10)))))))
        (local.set $refLane (i32.wrap_i64 (i64.rem_u (i64.shr_u (local.get $rand) (i64.const 32)) (i64.extend_i32_u (local.get $lanes)))))
        (if (i32.and (i32.eqz (local.get $pass)) (i32.eqz (local.get $slice)))
          (then (local.set $refLane (local.get $lane))))
        (local.set $refIndex (call $indexAlpha (local.get $pass) (local.get $slice) (local.get $i)
          (i64.and (local.get $rand) (i64.const 0xffffffff)) (i32.eq (local.get $refLane) (local.get $lane))
          (local.get $laneLen) (local.get $segLen)))
        (call $compress
          (i32.add (global.get $BASE) (i32.shl (local.get $prev) (i32.const 10)))
          (i32.add (global.get $BASE) (i32.shl (i32.add (i32.mul (local.get $refLane) (local.get $laneLen)) (local.get $refIndex)) (i32.const 10)))
          (i32.add (global.get $BASE) (i32.shl (local.get $curr) (i32.const 10)))
          (i32.ne (local.get $pass) (i32.const 0)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (local.set $curr (i32.add (local.get $curr) (i32.const 1)))
        (local.set $prev (i32.add (local.get $prev) (i32.const 1)))
        (br $each))))

  ;; Every pass, slice by slice; lanes in a slice are independent and run in turn.
  (func (export "fill") (param $lanes i32) (param $laneLen i32) (param $segLen i32) (param $passes i32)
    (local $pass i32) (local $slice i32) (local $lane i32)
    (local.set $pass (i32.const 0))
    (loop $passLoop
      (local.set $slice (i32.const 0))
      (loop $sliceLoop
        (local.set $lane (i32.const 0))
        (loop $laneLoop
          (call $segment (local.get $pass) (local.get $slice) (local.get $lane) (local.get $lanes)
            (local.get $laneLen) (local.get $segLen) (local.get $passes))
          (local.set $lane (i32.add (local.get $lane) (i32.const 1)))
          (br_if $laneLoop (i32.lt_u (local.get $lane) (local.get $lanes))))
        (local.set $slice (i32.add (local.get $slice) (i32.const 1)))
        (br_if $sliceLoop (i32.lt_u (local.get $slice) (i32.const 4))))
      (local.set $pass (i32.add (local.get $pass) (i32.const 1)))
      (br_if $passLoop (i32.lt_u (local.get $pass) (local.get $passes)))))
)
