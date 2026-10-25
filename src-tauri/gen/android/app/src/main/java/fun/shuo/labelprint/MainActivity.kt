package `fun`.shuo.labelprint

import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.view.View
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    /* 界面是纯白底，状态栏/导航栏图标必须固定深色。
     * 无参的 enableEdgeToEdge() 会跟随系统深浅色：系统在深色模式时给白图标，
     * 叠在白底上等于隐形。所以显式指定 light。
     * （targetSdk 37 起系统强制 edge-to-edge，没法靠关掉它来躲状态栏。） */
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT),
    )
    super.onCreate(savedInstanceState)

    /* 状态栏透明后网页视口从屏幕最顶上算起，<header> 就和时间/电量/刘海叠在一起了。
     *
     * 这里不让网页自己猜：Android WebView 对 env(safe-area-inset-top) 基本返回 0，
     * 光靠 CSS 解决不了。改由原生读真实 inset，把系统栏占掉的那圈让成 padding，
     * 网页看到的高度就正好是"状态栏以下"，前端一行都不用改。
     *
     * 只取 systemBars + displayCutout，不含软键盘（ime）：
     * 键盘弹出时若跟着让位，整个界面会被往上顶一截，反而更乱。 */
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      insets
    }
    ViewCompat.requestApplyInsets(content)

    // 让出来的那条缝要显示成界面同色（白），否则露的是窗口默认背景，深色模式下是黑的
    window.setBackgroundDrawable(ColorDrawable(Color.WHITE))
    val ctrl = WindowCompat.getInsetsController(window, content)
    ctrl.isAppearanceLightStatusBars = true
    ctrl.isAppearanceLightNavigationBars = true
  }
}
