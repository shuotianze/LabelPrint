// buildSrc 是独立构建，插件解析走自己的仓库。
// 官方 plugins.gradle.org 在本机被阻断（超时），所以优先用阿里云镜像。
pluginManagement {
    repositories {
        maven { url = uri("https://maven.aliyun.com/repository/gradle-plugin") }
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        maven { url = uri("https://maven.aliyun.com/repository/public") }
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
