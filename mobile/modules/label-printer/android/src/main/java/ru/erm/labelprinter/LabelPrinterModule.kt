package ru.erm.labelprinter

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.util.Locale
import java.util.UUID
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

class LabelPrinterException(message: String, cause: Throwable? = null) :
  CodedException("E_LABEL_PRINTER", message, cause)

private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
private const val CHUNK_SIZE = 1024
private const val BLACK_THRESHOLD = 150

data class LabelOptions(
  val widthMm: Double,
  val heightMm: Double,
  val gapMm: Double,
  val marginMm: Double,
  val dpi: Int,
  val density: Int,
  val direction: Int,
  val invert: Boolean,
  val copies: Int,
) {
  val dotsPerMm: Double get() = dpi / 25.4
  val widthDots: Int get() = (widthMm * dotsPerMm).roundToInt()
  val heightDots: Int get() = (heightMm * dotsPerMm).roundToInt()
  val marginDots: Int get() = (marginMm * dotsPerMm).roundToInt()

  companion object {
    fun from(map: Map<String, Any?>): LabelOptions {
      fun num(key: String, def: Double) = (map[key] as? Number)?.toDouble() ?: def
      return LabelOptions(
        widthMm = num("widthMm", 58.0).coerceIn(10.0, 110.0),
        heightMm = num("heightMm", 40.0).coerceIn(10.0, 300.0),
        gapMm = num("gapMm", 2.0).coerceIn(0.0, 20.0),
        marginMm = num("marginMm", 1.0).coerceIn(0.0, 10.0),
        dpi = num("dpi", 203.0).roundToInt().coerceIn(150, 600),
        density = num("density", 8.0).roundToInt().coerceIn(0, 15),
        direction = if (num("direction", 1.0).roundToInt() == 0) 0 else 1,
        invert = map["invert"] == true,
        copies = num("copies", 1.0).roundToInt().coerceIn(1, 100),
      )
    }
  }
}

class LabelPrinterModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("LabelPrinter")

    AsyncFunction("getBondedDevices") {
      bondedDevices()
    }

    AsyncFunction("printFile") { address: String, path: String, options: Map<String, Any?> ->
      val opts = LabelOptions.from(options)
      val label = labelFromFile(path, opts)
      try {
        send(address, buildTsplJob(label, opts))
      } finally {
        label.recycle()
      }
    }

    AsyncFunction("printTest") { address: String, options: Map<String, Any?> ->
      val opts = LabelOptions.from(options)
      val label = testLabel(opts)
      try {
        send(address, buildTsplJob(label, opts))
      } finally {
        label.recycle()
      }
    }
  }

  // region Bluetooth

  private fun adapter(): BluetoothAdapter {
    val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    val adapter = manager?.adapter ?: throw LabelPrinterException("На телефоне нет Bluetooth")
    if (!adapter.isEnabled) throw LabelPrinterException("Включите Bluetooth на телефоне")
    return adapter
  }

  @SuppressLint("MissingPermission")
  private fun bondedDevices(): List<Map<String, String>> {
    try {
      return adapter().bondedDevices.orEmpty()
        .map { mapOf("name" to (it.name ?: it.address), "address" to it.address) }
        .sortedBy { it["name"]?.lowercase(Locale.ROOT) }
    } catch (e: SecurityException) {
      throw LabelPrinterException("Нет разрешения на Bluetooth", e)
    }
  }

  @SuppressLint("MissingPermission")
  private fun connect(device: BluetoothDevice): BluetoothSocket {
    val factories = listOf<() -> BluetoothSocket>(
      { device.createRfcommSocketToServiceRecord(SPP_UUID) },
      { device.createInsecureRfcommSocketToServiceRecord(SPP_UUID) },
      {
        device.javaClass
          .getMethod("createRfcommSocket", Int::class.javaPrimitiveType)
          .invoke(device, 1) as BluetoothSocket
      },
    )
    var lastError: Exception? = null
    for (factory in factories) {
      var socket: BluetoothSocket? = null
      try {
        socket = factory()
        socket.connect()
        return socket
      } catch (e: SecurityException) {
        throw LabelPrinterException("Нет разрешения на Bluetooth", e)
      } catch (e: Exception) {
        lastError = e
        try {
          socket?.close()
        } catch (ignored: IOException) {
        }
      }
    }
    throw LabelPrinterException(
      "Не удалось подключиться к принтеру. Проверьте, что он включён и сопряжён с телефоном",
      lastError
    )
  }

  private fun send(address: String, data: ByteArray) {
    val device = try {
      adapter().getRemoteDevice(address)
    } catch (e: IllegalArgumentException) {
      throw LabelPrinterException("Некорректный адрес принтера", e)
    }
    val socket = connect(device)
    try {
      val out = socket.outputStream
      var offset = 0
      while (offset < data.size) {
        val n = min(CHUNK_SIZE, data.size - offset)
        out.write(data, offset, n)
        offset += n
      }
      out.flush()
      // Закрытие сокета сразу после write обрывает хвост задания в буфере принтера.
      Thread.sleep(800L + data.size / 40L)
    } catch (e: IOException) {
      throw LabelPrinterException("Связь с принтером прервалась: ${e.message ?: "ошибка передачи"}", e)
    } finally {
      try {
        socket.close()
      } catch (ignored: IOException) {
      }
    }
  }

  // endregion

  // region Rendering

  private class Placement(val rotate: Boolean, val width: Int, val height: Int)

  /** Размер источника в его ориентации, чтобы после поворота (если нужен) он вписался в этикетку с полями. */
  private fun placement(srcW: Double, srcH: Double, o: LabelOptions): Placement {
    val availW = max(8, o.widthDots - 2 * o.marginDots).toDouble()
    val availH = max(8, o.heightDots - 2 * o.marginDots).toDouble()
    val rotate = srcW != srcH && (srcW > srcH) != (availW > availH)
    val scale = if (rotate) min(availW / srcH, availH / srcW) else min(availW / srcW, availH / srcH)
    return Placement(rotate, max(1, (srcW * scale).roundToInt()), max(1, (srcH * scale).roundToInt()))
  }

  private fun labelFromFile(path: String, o: LabelOptions): Bitmap {
    val file = File(Uri.parse(path).path ?: path)
    if (!file.exists()) throw LabelPrinterException("Файл этикетки не найден")
    val (content, p) = if (file.name.endsWith(".pdf", ignoreCase = true)) renderPdf(file, o) else renderImage(file, o)
    try {
      return compose(content, p, o)
    } finally {
      content.recycle()
    }
  }

  private fun renderPdf(file: File, o: LabelOptions): Pair<Bitmap, Placement> {
    val fd = try {
      ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    } catch (e: IOException) {
      throw LabelPrinterException("Не удалось открыть PDF этикетки", e)
    }
    var renderer: PdfRenderer? = null
    var page: PdfRenderer.Page? = null
    try {
      renderer = PdfRenderer(fd)
      if (renderer.pageCount < 1) throw LabelPrinterException("В PDF этикетки нет страниц")
      page = renderer.openPage(0)
      val p = placement(page.width.toDouble(), page.height.toDouble(), o)
      val bitmap = Bitmap.createBitmap(p.width, p.height, Bitmap.Config.ARGB_8888)
      bitmap.eraseColor(Color.WHITE)
      page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_PRINT)
      return Pair(bitmap, p)
    } catch (e: IOException) {
      throw LabelPrinterException("Не удалось прочитать PDF этикетки", e)
    } finally {
      page?.close()
      renderer?.close()
      try {
        fd.close()
      } catch (ignored: IOException) {
      }
    }
  }

  private fun renderImage(file: File, o: LabelOptions): Pair<Bitmap, Placement> {
    val decoded = BitmapFactory.decodeFile(file.absolutePath)
      ?: throw LabelPrinterException("Не удалось прочитать изображение этикетки")
    val p = placement(decoded.width.toDouble(), decoded.height.toDouble(), o)
    var current = decoded
    // Поэтапное уменьшение: при сжатии больше чем в 2 раза за шаг тонкие штрихи штрихкода пропадают.
    while (current.width > p.width * 2 && current.height > p.height * 2) {
      val next = Bitmap.createScaledBitmap(current, current.width / 2, current.height / 2, true)
      if (current !== decoded) current.recycle()
      current = next
    }
    val scaled = Bitmap.createScaledBitmap(current, p.width, p.height, true)
    if (current !== scaled && current !== decoded) current.recycle()
    val flat = Bitmap.createBitmap(p.width, p.height, Bitmap.Config.ARGB_8888)
    flat.eraseColor(Color.WHITE)
    Canvas(flat).drawBitmap(scaled, 0f, 0f, null)
    if (scaled !== decoded) scaled.recycle()
    decoded.recycle()
    return Pair(flat, p)
  }

  private fun compose(content: Bitmap, p: Placement, o: LabelOptions): Bitmap {
    val w = o.widthDots
    val h = o.heightDots
    val label = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    label.eraseColor(Color.WHITE)
    val placedW = if (p.rotate) p.height else p.width
    val placedH = if (p.rotate) p.width else p.height
    val matrix = Matrix()
    if (p.rotate) {
      matrix.postRotate(90f)
      matrix.postTranslate(p.height.toFloat(), 0f)
    }
    matrix.postTranslate(((w - placedW) / 2).toFloat(), ((h - placedH) / 2).toFloat())
    Canvas(label).drawBitmap(content, matrix, null)
    return label
  }

  private fun testLabel(o: LabelOptions): Bitmap {
    val w = o.widthDots
    val h = o.heightDots
    val m = o.marginDots.toFloat() + 2f
    val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    bitmap.eraseColor(Color.WHITE)
    val canvas = Canvas(bitmap)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.BLACK
      style = Paint.Style.STROKE
      strokeWidth = 3f
    }
    canvas.drawRect(m, m, w - m, h - m, paint)
    paint.style = Paint.Style.FILL
    paint.typeface = Typeface.DEFAULT_BOLD
    paint.textSize = h * 0.15f
    canvas.drawText("ERM Склад", m + 14f, m + h * 0.22f, paint)
    paint.typeface = Typeface.DEFAULT
    paint.textSize = h * 0.09f
    canvas.drawText("Тест ${formatMm(o.widthMm)}×${formatMm(o.heightMm)} мм", m + 14f, m + h * 0.38f, paint)
    paint.isAntiAlias = false
    var x = m + 14f
    var bar = 1
    val top = h * 0.55f
    val bottom = h - m - 14f
    while (x + bar < w - m - 14f) {
      canvas.drawRect(x, top, x + bar, bottom, paint)
      x += bar * 2
      bar = bar % 4 + 1
    }
    return bitmap
  }

  // endregion

  // region TSPL

  private fun buildTsplJob(label: Bitmap, o: LabelOptions): ByteArray {
    val w = label.width
    val h = label.height
    val widthBytes = (w + 7) / 8
    // TSPL: бит 1 — пустая точка, 0 — чёрная.
    val raster = ByteArray(widthBytes * h) { 0xFF.toByte() }
    val row = IntArray(w)
    for (y in 0 until h) {
      label.getPixels(row, 0, w, 0, y, w, 1)
      for (x in 0 until w) {
        val c = row[x]
        val luminance = (Color.red(c) * 299 + Color.green(c) * 587 + Color.blue(c) * 114) / 1000
        if (luminance < BLACK_THRESHOLD) {
          val i = y * widthBytes + (x shr 3)
          raster[i] = (raster[i].toInt() and (0x80 ushr (x and 7)).inv()).toByte()
        }
      }
    }
    if (o.invert) {
      for (i in raster.indices) raster[i] = raster[i].toInt().inv().toByte()
    }

    val out = ByteArrayOutputStream(raster.size + 256)
    fun command(text: String) = out.write(text.toByteArray(Charsets.US_ASCII))
    command("SIZE ${formatMm(o.widthMm)} mm,${formatMm(o.heightMm)} mm\r\n")
    command("GAP ${formatMm(o.gapMm)} mm,0 mm\r\n")
    command("DIRECTION ${o.direction}\r\n")
    command("REFERENCE 0,0\r\n")
    command("DENSITY ${o.density}\r\n")
    command("CLS\r\n")
    command("BITMAP 0,0,$widthBytes,$h,0,")
    out.write(raster)
    command("\r\n")
    command("PRINT 1,${o.copies}\r\n")
    return out.toByteArray()
  }

  private fun formatMm(value: Double): String =
    if (value == value.roundToInt().toDouble()) value.roundToInt().toString()
    else String.format(Locale.US, "%.1f", value)

  // endregion
}
