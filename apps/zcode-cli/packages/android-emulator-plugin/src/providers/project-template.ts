import path from "node:path";

type TemplateInput = {
  compileSdk: number;
  minSdk: number;
  name: string;
  pkg: string;
};

type TemplateFile = {
  body: (input: TemplateInput) => string;
  path: string;
};

export function templateFiles(root: string, pkg: string, sdk?: string): TemplateFile[] {
  const pkgDir = pkg.replaceAll(".", "/");
  return [
    { path: path.join(root, "settings.gradle.kts"), body: settings },
    { path: path.join(root, "build.gradle.kts"), body: rootBuild },
    { path: path.join(root, "gradle.properties"), body: gradleProperties },
    ...(sdk
      ? [{ path: path.join(root, "local.properties"), body: () => localProperties(sdk) }]
      : []),
    { path: path.join(root, "gradle", "libs.versions.toml"), body: versions },
    { path: path.join(root, "app", "build.gradle.kts"), body: appBuild },
    { path: path.join(root, "app", "src", "main", "AndroidManifest.xml"), body: manifest },
    { path: path.join(root, "app", "src", "main", "res", "values", "strings.xml"), body: strings },
    { path: path.join(root, "app", "src", "main", "res", "values", "styles.xml"), body: styles },
    {
      path: path.join(root, "app", "src", "main", "java", pkgDir, "MainActivity.kt"),
      body: activity,
    },
  ];
}

function settings(input: TemplateInput) {
  return `pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "${input.name}"
include(":app")
`;
}

function rootBuild() {
  return `plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
}
`;
}

function gradleProperties() {
  return `android.useAndroidX=true
android.nonTransitiveRClass=true
org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
`;
}

function localProperties(sdk: string) {
  return `sdk.dir=${sdk.replaceAll("\\", "\\\\")}
`;
}

function versions() {
  return `[versions]
agp = "8.7.3"
kotlin = "2.0.21"
coreKtx = "1.15.0"
activityCompose = "1.9.3"
composeBom = "2024.12.01"

[libraries]
androidx-core-ktx = { group = "androidx.core", name = "core-ktx", version.ref = "coreKtx" }
androidx-activity-compose = { group = "androidx.activity", name = "activity-compose", version.ref = "activityCompose" }
androidx-compose-bom = { group = "androidx.compose", name = "compose-bom", version.ref = "composeBom" }
androidx-compose-ui = { group = "androidx.compose.ui", name = "ui" }
androidx-compose-ui-tooling-preview = { group = "androidx.compose.ui", name = "ui-tooling-preview" }
androidx-compose-material3 = { group = "androidx.compose.material3", name = "material3" }

[plugins]
android-application = { id = "com.android.application", version.ref = "agp" }
kotlin-android = { id = "org.jetbrains.kotlin.android", version.ref = "kotlin" }
kotlin-compose = { id = "org.jetbrains.kotlin.plugin.compose", version.ref = "kotlin" }
`;
}

function appBuild(input: TemplateInput) {
  return `plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "${input.pkg}"
    compileSdk = ${input.compileSdk}

    defaultConfig {
        applicationId = "${input.pkg}"
        minSdk = ${input.minSdk}
        targetSdk = ${input.compileSdk}
        versionCode = 1
        versionName = "1.0"
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
}
`;
}

function manifest() {
  return `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application
        android:allowBackup="true"
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:theme="@style/AppTheme">
        <activity
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`;
}

function strings(input: TemplateInput) {
  return `<resources>
    <string name="app_name">${input.name}</string>
</resources>
`;
}

function styles() {
  return `<resources>
    <style name="AppTheme" parent="android:style/Theme.Material.Light.NoActionBar" />
</resources>
`;
}

function activity(input: TemplateInput) {
  return `package ${input.pkg}

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            App()
        }
    }
}

@Composable
fun App() {
    var count by remember { mutableIntStateOf(0) }

    MaterialTheme {
        Surface(modifier = Modifier.fillMaxSize()) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text(
                    text = "Hello from Android",
                    style = MaterialTheme.typography.headlineMedium,
                )
                Text(
                    text = "Count: $count",
                    modifier = Modifier.semantics { contentDescription = "countLabel" },
                    style = MaterialTheme.typography.titleLarge,
                )
                Button(
                    onClick = { count += 1 },
                    modifier = Modifier.semantics { contentDescription = "incrementButton" },
                ) {
                    Text("Increment")
                }
            }
        }
    }
}
`;
}
